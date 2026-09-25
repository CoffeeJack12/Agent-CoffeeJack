/**
 * Jeddawi Renderer — fallback repair only.
 * Primary path: qwen3:14b writes FINAL Jeddawi directly; this stage runs
 * at most once when the cheap direct guard fails.
 */

import {
  JEDDAWI_FORBIDDEN,
  JEDDAWI_RENDERER_MODEL,
  buildJeddawiRendererSystemPrompt,
  isVerbatimStyleExample,
} from "./styles/jeddawi.mjs";
import { isJeddawiActive, normalizeConversationStyle } from "./conversation-style.mjs";
import {
  outputAbandonsTopic,
  semanticArabicFallback,
} from "./jeddawi-semantics.mjs";

const EGYPTIAN_OR_LEVANTINE =
  /مفيش|ما\s*فيش|عايز|عاوز|(?:^|[^\u0600-\u06ff])مش(?:[^\u0600-\u06ff]|$)|إزاي|ازاي|(?:^|[^\u0600-\u06ff])شو(?:[^\u0600-\u06ff]|$)|هيك|(?:^|[^\u0600-\u06ff])بدي(?:[^\u0600-\u06ff]|$)|حابب(?:تش|ش)|عايزين|كده|أوي/u;
const NONSENSE_RE =
  /مالك\s*تعب|تعبّ?د\s*ليش|جدة\s*نايم|خلّ?ك\s*جدة/u;
const LATIN_TRANSLIT_RE =
  /\b(?:Duhin|Duheen|Asr|Isha|Maghrib|Fajr|Yalla(?!\s*[A-Za-z])|Abgha)\b/i;
const ARABIC_RE = /[\u0600-\u06ff]/;

/**
 * Cheap deterministic guard for direct Jeddawi output (no model call).
 * @returns {{ ok: boolean, code?: string, detail?: string }}
 */
export function guardJeddawiDirect(text = "") {
  const body = String(text || "").trim();
  if (!body) {
    return { ok: false, code: "empty", detail: "Empty Jeddawi output." };
  }
  for (const tok of JEDDAWI_FORBIDDEN) {
    if (tok === "مش") {
      if (/(?:^|[^\u0600-\u06ff])مش(?:[^\u0600-\u06ff]|$)/u.test(body)) {
        return { ok: false, code: "forbidden", detail: `Forbidden token: ${tok}` };
      }
      continue;
    }
    if (body.includes(tok)) {
      return { ok: false, code: "forbidden", detail: `Forbidden token: ${tok}` };
    }
  }
  if (EGYPTIAN_OR_LEVANTINE.test(body)) {
    return {
      ok: false,
      code: "contamination",
      detail: "Egyptian/Levantine contamination.",
    };
  }
  if (LATIN_TRANSLIT_RE.test(body)) {
    return {
      ok: false,
      code: "transliteration",
      detail: "Latin transliteration of Arabic (e.g. Duhin/Asr).",
    };
  }
  if (NONSENSE_RE.test(body) || /روح\s*واجبه/u.test(body)) {
    return { ok: false, code: "malformed", detail: "Broken/fake Hijazi phrasing." };
  }
  if (isVerbatimStyleExample(body)) {
    return {
      ok: false,
      code: "example_copy",
      detail: "Direct output copied a style demonstration.",
    };
  }
  const parts = body
    .split(/[،.؟!\n]+/u)
    .map((p) => p.trim())
    .filter((p) => p.length >= 6);
  if (parts.length >= 2) {
    const seen = new Set();
    for (const p of parts) {
      if (seen.has(p)) {
        return { ok: false, code: "repetitive", detail: "Excessive clause repetition." };
      }
      seen.add(p);
    }
  }
  const arabic = (body.match(/[\u0600-\u06ff]/g) || []).length;
  const latin = (body.match(/[A-Za-z]/g) || []).length;
  // Short English-only replies while Jeddawi is active.
  if (arabic < 3 && latin >= 6) {
    return {
      ok: false,
      code: "english",
      detail: "Answer is primarily English while Jeddawi is active.",
    };
  }
  if (latin > 24 && arabic < latin * 0.35) {
    return {
      ok: false,
      code: "english",
      detail: "Answer is primarily English while Jeddawi is active.",
    };
  }
  return { ok: true };
}

/**
 * Re-attach protected user spans (paths, commands, URLs, code) if the model dropped them.
 */
export function reattachProtectedSpans(answer = "", userText = "") {
  let out = String(answer || "");
  const spans = extractProtectedSpans(userText).spans;
  for (const span of spans) {
    if (span.value && !out.includes(span.value)) {
      out = out.trimEnd() + `\n${span.value}`;
    }
  }
  return out;
}

/** Extract protected spans so the model cannot rewrite them. */
export function extractProtectedSpans(text = "") {
  const body = String(text || "");
  const found = [];
  const patterns = [
    /```[\s\S]*?```/g,
    /`[^`\n]+`/g,
    /https?:\/\/[^\s<>"']+/gi,
    /[A-Za-z]:\\[^\s"'<>]+/g,
    /\\\\[^\s"'<>]+/g,
    /\b(?:npm|npx|node|git|ollama|pwsh|powershell)\s+[^\n]+/gi,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  ];
  const occupied = new Array(body.length).fill(false);
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body))) {
      const start = m.index;
      const end = start + m[0].length;
      let overlap = false;
      for (let p = start; p < end; p++) {
        if (occupied[p]) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;
      for (let p = start; p < end; p++) occupied[p] = true;
      found.push({ start, end, value: m[0] });
    }
  }
  found.sort((a, b) => a.start - b.start);
  const spans = [];
  let masked = "";
  let cursor = 0;
  let i = 0;
  for (const span of found) {
    masked += body.slice(cursor, span.start);
    const id = `⟦CJ${i++}⟧`;
    spans.push({ id, value: span.value });
    masked += id;
    cursor = span.end;
  }
  masked += body.slice(cursor);
  return { masked, spans };
}

export function restoreProtectedSpans(text = "", spans = []) {
  let out = String(text || "");
  for (const span of spans) {
    out = out.split(span.id).join(span.value);
  }
  return out;
}

export function extractNumbers(text = "") {
  return (String(text).match(/\d+(?:[.,]\d+)?/g) || []).sort();
}

export function extractUrls(text = "") {
  return (String(text).match(/https?:\/\/[^\s<>"']+/gi) || []).sort();
}

export function extractWindowsPaths(text = "") {
  return (String(text).match(/[A-Za-z]:\\[^\s"'<>]+/g) || []).sort();
}

export function extractCodeFences(text = "") {
  return String(text).match(/```[\s\S]*?```/g) || [];
}

/**
 * @returns {{ ok: boolean, code?: string, detail?: string }}
 */
export function validateJeddawiRender(draft = "", rendered = "") {
  const src = String(draft || "").trim();
  const out = String(rendered || "").trim();
  if (!out) return { ok: false, code: "empty", detail: "Renderer returned empty text." };

  for (const tok of JEDDAWI_FORBIDDEN) {
    if (tok === "مش") {
      if (/(?:^|[^\u0600-\u06ff])مش(?:[^\u0600-\u06ff]|$)/u.test(out)) {
        return { ok: false, code: "forbidden", detail: `Forbidden token: ${tok}` };
      }
      continue;
    }
    if (out.includes(tok)) {
      return { ok: false, code: "forbidden", detail: `Forbidden token: ${tok}` };
    }
  }
  if (EGYPTIAN_OR_LEVANTINE.test(out)) {
    return { ok: false, code: "contamination", detail: "Egyptian/Levantine contamination." };
  }
  if (NONSENSE_RE.test(out)) {
    return { ok: false, code: "malformed", detail: "Broken/fake Hijazi phrasing." };
  }

  if (/⟦CJ\d*#?⟧|⟦CJ/.test(out)) {
    return {
      ok: false,
      code: "placeholders",
      detail: "Renderer left unresolved protection placeholders.",
    };
  }
  if (/[\u{1F300}-\u{1FAFF}]/u.test(out)) {
    return { ok: false, code: "emoji", detail: "Emoji not allowed in Jeddawi output." };
  }

  const draftNums = extractNumbers(src);
  const outNums = extractNumbers(out);
  if (draftNums.join("|") !== outNums.join("|")) {
    return { ok: false, code: "numbers", detail: "Numbers changed by renderer." };
  }
  const draftUrls = extractUrls(src);
  const outUrls = extractUrls(out);
  if (draftUrls.join("|") !== outUrls.join("|")) {
    return { ok: false, code: "urls", detail: "URLs changed by renderer." };
  }
  const draftPaths = extractWindowsPaths(src);
  const outPaths = extractWindowsPaths(out);
  if (draftPaths.join("|") !== outPaths.join("|")) {
    return { ok: false, code: "paths", detail: "File paths changed by renderer." };
  }
  const draftFences = extractCodeFences(src);
  const outFences = extractCodeFences(out);
  if (draftFences.length !== outFences.length) {
    return { ok: false, code: "code", detail: "Code fences altered by renderer." };
  }
  for (let i = 0; i < draftFences.length; i++) {
    if (draftFences[i] !== outFences[i]) {
      return { ok: false, code: "code", detail: "Code fence content changed." };
    }
  }

  // Commands: if draft had an npm/git line, it must appear unchanged.
  const cmdRe = /\b(?:npm|npx|node|git|ollama|pwsh|powershell)\s+[^\n]+/gi;
  const draftCmds = src.match(cmdRe) || [];
  for (const cmd of draftCmds) {
    if (!out.includes(cmd.trim())) {
      return { ok: false, code: "commands", detail: `Command altered: ${cmd.trim()}` };
    }
  }

  const arabic = (out.match(/[\u0600-\u06ff]/g) || []).length;
  const latin = (out.match(/[A-Za-z]/g) || []).length;
  // Pure-technical drafts may stay mostly Latin; otherwise require Arabic prose.
  if (ARABIC_RE.test(src) && arabic < 8 && latin > 20) {
    return {
      ok: false,
      code: "english",
      detail: "Renderer produced unexpected English for an Arabic draft.",
    };
  }

  return { ok: true };
}

export function shouldInvokeJeddawiRenderer(style = {}) {
  return isJeddawiActive(style);
}

/**
 * Run Jeddawi Renderer once (no retry loop). Falls back to the direct draft.
 *
 * @returns {Promise<{
 *   text: string,
 *   usedRenderer: boolean,
 *   fallback: boolean,
 *   attempts: number,
 *   renderMs: number,
 *   model: string,
 *   violation?: object,
 * }>}
 */
export async function renderJeddawiAnswer({
  ollama,
  draft,
  style,
  signal,
  profile,
  topic = null,
  semanticTurn = null,
} = {}) {
  const s = normalizeConversationStyle(style);
  const semantic = String(draft || "").trim();
  if (!semantic || !shouldInvokeJeddawiRenderer(s)) {
    return {
      text: semantic,
      usedRenderer: false,
      fallback: false,
      attempts: 0,
      renderMs: 0,
      model: null,
    };
  }

  const { masked, spans } = extractProtectedSpans(semantic);
  const system = buildJeddawiRendererSystemPrompt({
    tone: s.tone,
    verbosity: s.verbosity,
    topic,
  });
  const model = JEDDAWI_RENDERER_MODEL;
  const t0 = performance.now();
  let attempts = 0;

  try {
    attempts = 1;
    const userContent = [
      "Rewrite this DIRECT DRAFT into natural Jeddawi Arabic.",
      "Preserve meaning, numbers, paths, commands, URLs, and every placeholder token exactly (⟦CJ#⟧).",
      "DIRECT DRAFT:",
      masked,
    ].join("\n");

    let streamed = "";
    const response = await ollama.chat({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      tools: [],
      profile: {
        think: false,
        keepAlive: "5m",
        context: Math.min(profile?.context || 4096, 6144),
        predict: Math.min(Math.max(profile?.predict || 1024, 512), 2048),
      },
      signal,
      onToken: (tok) => {
        streamed += tok;
      },
    });
    const raw = (streamed || response?.content || "").trim();
    const restored = restoreProtectedSpans(raw, spans).trim();
    const check = validateJeddawiRender(semantic, restored);
    const drifted = outputAbandonsTopic(restored, topic, semanticTurn);
    if (!check.ok || drifted || isVerbatimStyleExample(restored)) {
      const clean = semanticArabicFallback({
        topic,
        semantic: semanticTurn,
        draft: semantic,
      });
      return {
        text: clean,
        usedRenderer: true,
        fallback: true,
        meaningChanged: Boolean(drifted),
        attempts,
        renderMs: Math.round(performance.now() - t0),
        model,
        violation: drifted
          ? { code: "topic_drift", detail: "Renderer changed the canonical topic." }
          : check,
      };
    }
    return {
      text: restored || semantic,
      usedRenderer: true,
      fallback: false,
      attempts,
      renderMs: Math.round(performance.now() - t0),
      model,
    };
  } catch (error) {
    return {
      text: semanticArabicFallback({
        topic,
        semantic: semanticTurn,
        draft: semantic,
      }),
      usedRenderer: true,
      fallback: true,
      attempts,
      renderMs: Math.round(performance.now() - t0),
      model,
      violation: {
        code: "error",
        detail: String(error?.message || error || "render failed"),
      },
    };
  }
}
