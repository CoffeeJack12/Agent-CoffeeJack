import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, "language", "worker.py");
const repoRoot = path.resolve(here, "..");
const localJava = path.join(
  repoRoot,
  ".runtime",
  "farasa-jre",
  "bin",
  process.platform === "win32" ? "java.exe" : "java",
);
const DEFAULT_FALLBACK_TIMEOUT_MS = 4000;
const MAX_WORKER_OUTPUT = 64 * 1024;

const PHRASE_ALIASES = new Map([
  ["luaools", "LuaTools"],
  ["luatols", "LuaTools"],
  ["luatool", "LuaTools"],
  ["luatoolz", "LuaTools"],
  ["lua tools", "LuaTools"],
  ["coffejack", "CoffeeJack"],
  ["coffee jack", "CoffeeJack"],
  ["britrix", "Bitrix24"],
  ["bitrex", "Bitrix24"],
]);

const ARABIC_HINTS = new Map([
  ["ابغا", "أريد"],
  ["أبغا", "أريد"],
  ["ابغى", "أريد"],
  ["أبغى", "أريد"],
  ["دحين", "الآن"],
  ["الحين", "الآن"],
  ["سويه", "نفذه"],
  ["سويها", "نفذها"],
]);

// Farasa returns bare stems; the routing classifiers match imperative forms.
const ROUTING_STEM_FORMS = new Map([
  ["فتح", "افتح"],
  ["بحث", "ابحث"],
  ["فحص", "افحص"],
  ["ثبت", "ثبت"],
  ["شغل", "شغل"],
  ["حمل", "حمل"],
  ["نزل", "نزل"],
]);

const ARABIC_RE = /[\u0600-\u06ff]/u;
const ARABIC_WORD_RE = /[\u0621-\u064a\u0671-\u06d3]+/gu;
const ARABIC_ROUTING_ROOTS =
  /(?:فتح|شغل|حمل|نزل|بحث|دور|ثبت|فحص|شيك|صلح|عدل|ستيم|برنامج|البرنامج|ملف|الملف|متصفح|المتصفح|جهاز|لعبة|اللعبة)/u;

function replaceWholeWord(text, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "giu"), to);
}

export function normalizeKnownLanguage(text = "") {
  const original = String(text || "");
  let normalized = original;
  const changes = [];

  for (const [from, to] of PHRASE_ALIASES) {
    const next = replaceWholeWord(normalized, from, to);
    if (next !== normalized) {
      changes.push({ from, to, reason: "known_alias" });
      normalized = next;
    }
  }

  for (const [from, to] of ARABIC_HINTS) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const next = normalized.replace(
      new RegExp(`(?<![\\u0600-\\u06ff])${escaped}(?![\\u0600-\\u06ff])`, "gu"),
      to,
    );
    if (next !== normalized) {
      changes.push({ from, to, reason: "arabic_hint" });
      normalized = next;
    }
  }

  return { original, text: normalized, changed: normalized !== original, changes };
}
const fallbackCache = new Map();

function pythonExecutable() {
  const candidates = [
    process.env.COFFEEJACK_PYTHON,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python312", "python.exe")
      : null,
    "C:\\Python312\\python.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export function shouldUseLanguageFallback(text = "") {
  const value = String(text || "").trim();
  if (!value || value.length > 320) return false;
  const commandish = /\b(?:use|open|launch|download|install|find|search|check|inspect|fix|run|start|stop|connect|sync|update|add|remove)\b|(?:ابغا|أبغا|ابغى|أبغى|سوي|سويه|سويها|افتح|شغل|حمل|حمّل|نزل|نزّل|دور|ابحث|شيك|افحص|صلح|عدل|اربط|حدث|ضيف|احذف)/iu.test(value);
  const hasLatin = /[A-Za-z]{4,}/.test(value);
  const hasArabic = ARABIC_RE.test(value);
  if (commandish && (hasLatin || hasArabic)) return true;
  return hasArabic && ARABIC_ROUTING_ROOTS.test(value);
}

function killProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    return Promise.resolve();
  }
  // Python spawns java.exe; killing python.exe alone would orphan the JVM.
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const done = () => {
      clearTimeout(cap);
      resolve();
    };
    const cap = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      done();
    }, 3000);
    killer.once("exit", done);
    killer.once("error", () => {
      try {
        child.kill("SIGKILL");
      } catch {}
      done();
    });
  });
}

function waitForExit(child, capMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const cap = setTimeout(resolve, capMs);
    child.once("exit", () => {
      clearTimeout(cap);
      resolve();
    });
  });
}

const cancelledError = () =>
  Object.assign(new Error("Language fallback cancelled"), { code: "ABORT_ERR" });

function runWorker(args, input, { signal, timeoutMs = DEFAULT_FALLBACK_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const python = pythonExecutable();
    if (!python) {
      reject(new Error("Language fallback Python unavailable"));
      return;
    }
    const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
    let child = null;
    let settled = false;
    let timer = null;
    const settle = (error, stdout) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!error) {
        resolve(stdout);
        return;
      }
      Promise.all([killProcessTree(child), waitForExit(child)]).then(() => reject(error));
    };
    // Registered before execFile's own abort listener so the tree kill starts
    // while python.exe is still alive to anchor taskkill /T.
    const onAbort = () => settle(cancelledError());
    signal?.addEventListener("abort", onAbort, { once: true });
    child = execFile(
      python,
      ["-X", "utf8", worker, ...args],
      {
        windowsHide: true,
        detached: process.platform !== "win32",
        encoding: "utf8",
        maxBuffer: MAX_WORKER_OUTPUT,
        killSignal: "SIGKILL",
        signal,
        env,
      },
      (error, stdout) => {
        if (!error) return settle(null, stdout);
        if (error.name === "AbortError" || error.code === "ABORT_ERR")
          return settle(cancelledError());
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          return settle(new Error("Language fallback output too large"));
        if (typeof error.code === "number")
          return settle(new Error(`Language fallback exited with code ${error.code}`));
        return settle(error);
      },
    );
    timer = setTimeout(
      () =>
        settle(
          Object.assign(new Error(`Language fallback timed out after ${timeoutMs}ms`), {
            code: "ETIMEDOUT",
          }),
        ),
      timeoutMs,
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(String(input || ""), "utf8");
  });
}

function parseWorkerOutput(stdout = "") {
  const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith("{")) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  throw new Error("Language fallback returned no JSON");
}

function sanitizeStems(stems, text) {
  if (!Array.isArray(stems)) return [];
  const present = new Set(String(text || "").match(ARABIC_WORD_RE) || []);
  const out = [];
  for (const stem of stems) {
    const value = String(stem || "");
    if (!/^[\u0621-\u064a\u0671-\u06d3]{2,24}$/u.test(value)) continue;
    if (present.has(value) || out.includes(value)) continue;
    out.push(value);
    if (out.length >= 24) break;
  }
  return out;
}

export async function enrichLanguageOnDemand(
  text = "",
  { force = false, signal, timeoutMs = DEFAULT_FALLBACK_TIMEOUT_MS, arabicRouting = true } = {},
) {
  const fast = normalizeKnownLanguage(text);
  if (fast.changed || (!force && !shouldUseLanguageFallback(fast.text)))
    return { ...fast, source: fast.changed ? "fast_alias" : "none", routingStems: [], fallbackMs: 0 };

  const wantsFarasa = Boolean(arabicRouting) && ARABIC_RE.test(fast.text);
  // Farasa only runs from the portable JRE plus the pre-installed jar (checked
  // again by the worker); nothing is ever downloaded at request time.
  const useFarasa = wantsFarasa && fs.existsSync(localJava);
  const cacheKey = `${useFarasa ? "ar" : "lt"}\u0000${fast.text}`;
  const cached = fallbackCache.get(cacheKey);
  if (cached) return { ...cached, source: "cache", fallbackMs: 0 };
  const python = pythonExecutable();
  if (!python || !fs.existsSync(worker))
    return { ...fast, source: "none", routingStems: [], fallbackMs: 0, unavailable: true };

  const started = Date.now();
  try {
    const stdout = await runWorker(useFarasa ? ["--farasa"] : [], fast.text, {
      signal,
      timeoutMs,
    });
    const parsed = parseWorkerOutput(stdout);
    const enrichedText = String(parsed.text || fast.text);
    const routingStems = useFarasa ? sanitizeStems(parsed.routing_stems, enrichedText) : [];
    const result = {
      original: fast.original,
      text: enrichedText,
      changed: Boolean(parsed.changed) || enrichedText !== fast.original,
      changes: [...fast.changes, ...(Array.isArray(parsed.changes) ? parsed.changes : [])],
      source: useFarasa && parsed.farasa === "ok" ? "farasa_wordfreq" : "wordfreq",
      farasa: useFarasa
        ? typeof parsed.farasa === "string"
          ? parsed.farasa
          : "skipped"
        : wantsFarasa
          ? "unavailable"
          : "skipped",
      routingStems,
      fallbackMs: Date.now() - started,
    };
    if (!parsed.error) {
      fallbackCache.set(cacheKey, result);
      if (fallbackCache.size > 256) fallbackCache.delete(fallbackCache.keys().next().value);
    }
    return result;
  } catch (error) {
    const cancelled = error?.code === "ABORT_ERR";
    return {
      ...fast,
      source: cancelled ? "fallback_cancelled" : "fallback_failed",
      routingStems: [],
      cancelled,
      timedOut: error?.code === "ETIMEDOUT",
      fallbackMs: Date.now() - started,
      error: String(error?.message || error).slice(0, 200),
    };
  }
}

/** Arabic routing tokens derived from stems; never part of user-facing text. */
export function routingTokensFromStems(stems = [], text = "") {
  const tokens = [];
  for (const stem of sanitizeStems(stems, text)) {
    tokens.push(stem);
    const form = ROUTING_STEM_FORMS.get(stem);
    if (form && form !== stem) tokens.push(form);
  }
  return [...new Set(tokens)];
}

function replaceDeep(value, from, to, depth = 0) {
  if (typeof value === "string") return value.split(from).join(to);
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, from, to, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = replaceDeep(item, from, to, depth + 1);
  return out;
}

const CLASSIFICATION_FIELDS = [
  "effectiveIntent",
  "directive",
  "intent",
  "conversational",
  "expandWithContext",
  "taskHint",
  "fastPath",
  "allowResearch",
  "allowVerification",
  "allowMemoryWrite",
  "allowRememberTool",
  "allowWebSearch",
  "allowMemoryRecall",
  "needsVerification",
  "resetTaskState",
  "isolateSecurityContext",
  "securityIntent",
  "diagnostic",
];

/**
 * Re-classify an ambiguous turn using Farasa stems as extra routing evidence.
 * Stems only influence which route is chosen: every text-bearing field of the
 * returned turn is rebuilt from the clean user text, effectiveIntent is always
 * the normalized request itself, and the probe is dropped if any stem-bearing
 * text would survive.
 */
export function resolveTurnWithRoutingStems({ text = "", stems = [], resolve, base = null } = {}) {
  const clean = String(text || "").trim();
  const baseTurn = base || resolve(clean);
  const tokens = routingTokensFromStems(stems, clean);
  const priorityLane = baseTurn?.priorityLane || "normal";
  if (baseTurn?.taskHint || priorityLane !== "normal" || !tokens.length)
    return { turn: baseTurn, usedStems: false };

  const suffix = tokens.join(" ");
  const probeText = `${clean} ${suffix}`;
  const probe = resolve(probeText);
  if (!probe?.taskHint || (probe.priorityLane || "normal") !== "normal")
    return { turn: baseTurn, usedStems: false };

  const classified = {};
  for (const field of CLASSIFICATION_FIELDS) {
    if (field in probe) classified[field] = replaceDeep(probe[field], probeText, clean);
  }
  const isolated = {};
  if (probe.isolateSecurityContext) {
    isolated.snapshot = replaceDeep(probe.snapshot, probeText, clean);
    isolated.threadContext = "";
    isolated.canonicalTopic = replaceDeep(probe.canonicalTopic, probeText, clean);
  }
  const addedOnly = tokens.filter((token) => countArabicWord(clean, token) === 0);
  const { directive: probeDirective, ...probeFields } = { ...classified, ...isolated };
  const strict = JSON.stringify(probeFields);
  const directive = JSON.stringify(probeDirective ?? "");
  const baseDirective = JSON.stringify(baseTurn?.directive ?? "");
  const leaked =
    directive.includes(suffix) ||
    addedOnly.some(
      (token) =>
        countArabicWord(strict, token) > 0 ||
        countArabicWord(directive, token) > countArabicWord(baseDirective, token),
    );
  if (leaked) return { turn: baseTurn, usedStems: false };
  return {
    turn: { ...baseTurn, ...classified, ...isolated, effectiveIntent: clean, rawText: clean },
    usedStems: true,
  };
}

function countArabicWord(haystack, word) {
  const escaped = String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\u0600-\\u06ff])${escaped}(?![\\u0600-\\u06ff])`, "gu");
  return (String(haystack || "").match(re) || []).length;
}

export async function probeLanguageDependencies({ signal, timeoutMs = 8000 } = {}) {
  const python = pythonExecutable();
  if (!python || !fs.existsSync(worker))
    return { python: Boolean(python), worker: fs.existsSync(worker), wordfreq: false, farasa: false };
  try {
    const parsed = parseWorkerOutput(await runWorker(["--probe"], "", { signal, timeoutMs }));
    return {
      python: true,
      worker: true,
      wordfreq: Boolean(parsed.ok),
      farasa: Boolean(parsed.farasa?.available),
      java: Boolean(parsed.farasa?.java),
      jar: Boolean(parsed.farasa?.jar),
    };
  } catch (error) {
    return { python: true, worker: true, wordfreq: false, farasa: false, error: String(error?.message || error) };
  }
}

export function languageLayerInfo() {
  return {
    persistentProcess: false,
    cacheEntries: fallbackCache.size,
    python: Boolean(pythonExecutable()),
    worker: fs.existsSync(worker),
  };
}
