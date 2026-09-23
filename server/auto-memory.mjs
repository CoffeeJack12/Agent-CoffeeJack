import { randomUUID } from "node:crypto";
import { validateMemory } from "./memory.mjs";
import { savePreferences } from "./preferences.mjs";

const SECRET =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{16,}|github_pat_[a-zA-Z0-9_]{16,}|AKIA[A-Z0-9]{16})|\bBearer\s+[\w.~-]{12,}|\b(?:password|passwd|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*\S+/i;

const EPHEMERAL =
  /\b(?:acceptance.?test|live.?acceptance|temporary (?:fixture|project|workspace)|tmp[-_ ]?project|isolated temp(?:orary)?)\b/i;

const RULES = [
  {
    type: "preference",
    setting: { address: "lord" },
    re: /\b(?:call me|address me as|from now on(?: call me)?)\s+lord\b|نادني\s*لورد|اسمي\s*لورد/i,
    content: () => `Address preference: Lord`,
    confidence: 0.95,
  },
  {
    type: "preference",
    setting: { address: "master" },
    re: /\b(?:call me|address me as)\s+master\b|نادني\s*ماستر/i,
    content: () => `Address preference: Master`,
    confidence: 0.95,
  },
  {
    type: "preference",
    setting: { address: "sir" },
    re: /\b(?:call me|address me as)\s+sir\b/i,
    content: () => `Address preference: Sir`,
    confidence: 0.95,
  },
  {
    type: "preference",
    setting: { verbosity: "concise" },
    re: /\b(?:keep (?:it |answers? |replies? )?(?:short|concise)|prefer(?:s)? (?:short|concise) answers?|be concise|concise answers?)\b|اختصر|ردود قصيرة|إجابات مختصرة/i,
    content: () => "Prefers concise answers",
    confidence: 0.9,
  },
  {
    type: "preference",
    setting: { verbosity: "detailed" },
    re: /\b(?:be (?:more )?detailed|prefer detailed|explain in detail)\b|بالتفصيل|وضح أكثر/i,
    content: () => "Prefers detailed answers",
    confidence: 0.85,
  },
  {
    type: "preference",
    setting: { appLanguage: "en" },
    re: /\b(?:(?:coffeejack|the app|the ui|the interface|application).{0,40}(?:in )?english|(?:set|switch|change).{0,20}(?:app|ui|interface|coffeejack).{0,20}english|i want (?:coffeejack|the app)(?: itself)? in english)\b/i,
    content: () => "App language preference: English",
    confidence: 0.95,
  },
  {
    type: "preference",
    setting: { appLanguage: "ar" },
    re: /\b(?:(?:coffeejack|the app|the ui|the interface).{0,40}arabic|أريد\s*(?:التطبيق|الواجهة|كوفي جاك).{0,20}عربي)\b|الواجهة بالعربي/i,
    content: () => "App language preference: Arabic",
    confidence: 0.95,
  },
  {
    type: "preference",
    setting: { language: "en" },
    re: /\b(?:prefer(?:s)? english|reply in english|speak english)\b|فضّل الإنجليزية|رد بالإنجليزي/i,
    content: () => "Assistant language preference: English",
    confidence: 0.85,
  },
  {
    type: "preference",
    re: /\b(?:don'?t|do not|never) use emojis?\b|بدون إيموجي|لا تستخدم إيموجي/i,
    content: () => "Do not use emojis",
    confidence: 0.9,
  },
  {
    type: "environment",
    re: /\b(?:i use|i'?m on|running) windows\b|استخدم ويندوز|على ويندوز/i,
    content: () => "Uses Windows",
    confidence: 0.9,
  },
  {
    type: "project",
    re: /\b(?:my project is|working on(?: the)? project)\s+([A-Za-z0-9._-]{2,40})\b|مشروعي\s+([^\s،.]{2,40})/i,
    content: (m) => `Project: ${m[1] || m[2]}`,
    confidence: 0.85,
  },
];

export function extractMemories(text = "") {
  if (SECRET.test(text)) return [];
  if (EPHEMERAL.test(text)) return [];
  if (typeof text !== "string" || text.length < 4 || text.length > 2000)
    return [];
  if (
    /^(inspect|check|search|open|run|fix|build|git|npm)\b/i.test(text.trim()) &&
    text.length < 80
  )
    return [];
  const found = [];
  for (const rule of RULES) {
    const match = text.match(rule.re);
    if (!match) continue;
    const content = rule.content(match);
    if (!content || SECRET.test(content) || EPHEMERAL.test(content)) continue;
    found.push({
      content,
      type: rule.type,
      kind:
        rule.type === "preference"
          ? "preference"
          : rule.type === "project"
            ? "note"
            : "note",
      setting: rule.setting || null,
      confidence: rule.confidence,
    });
  }
  return found.slice(0, 4);
}

export function applyAutomaticMemory(
  store,
  text,
  { chatId = null, behavior = "auto", preferences } = {},
) {
  if (behavior === "off") return { saved: [], pending: [], preferences };
  const extracted = extractMemories(text);
  const saved = [];
  const pending = [];
  let nextPrefs = preferences;
  for (const item of extracted) {
    if (behavior === "ask") {
      pending.push(item);
      continue;
    }
    try {
      const committed = commitMemoryItem(store, item, chatId);
      saved.push({ ...item, id: committed.id });
      if (committed.preferences) nextPrefs = committed.preferences;
    } catch {
      /* secrets / validation */
    }
  }
  return { saved, pending, preferences: nextPrefs };
}

/** Persist one durable memory (+ optional preference sync). */
export function commitMemoryItem(store, item, chatId = null) {
  const content =
    typeof item.content === "string" ? item.content.trim() : "";
  if (!content) throw new Error("Memory is empty");
  if (SECRET.test(content)) throw new Error("Credentials cannot be stored");
  const kind = ["preference", "lesson", "note"].includes(item.kind)
    ? item.kind
    : "note";
  validateMemory(content, kind);
  const similar = store
    .memories("")
    .filter((m) => m.kind === kind)
    .find((m) => similarText(m.content, content));
  let id;
  if (similar) {
    store.updateMemory?.(similar.id, {
      content,
      chatId,
      confidence: item.confidence,
      category: item.type,
    });
    id = similar.id;
  } else {
    id = store.remember(content, kind, null, {
      chatId,
      confidence: item.confidence,
      category: item.type,
    });
  }
  let preferences = null;
  if (item.setting) preferences = savePreferences(store, item.setting);
  return { id, preferences };
}

/**
 * In-memory Ask proposals. Does not block the agent reply.
 * @returns {{
 *   enqueue: (items: object[], chatId: string|null) => object[],
 *   resolve: (id: string, action: 'save'|'discard'|'edit', content?: string) => object,
 *   get: (id: string) => object|undefined,
 *   size: () => number,
 * }}
 */
export function createMemoryProposalStore(store) {
  const proposals = new Map();
  return {
    enqueue(items, chatId = null) {
      const out = [];
      for (const item of items) {
        const id = randomUUID();
        proposals.set(id, {
          ...item,
          id,
          chatId,
          createdAt: Date.now(),
        });
        out.push({
          id,
          content: item.content,
          type: item.type,
          kind: item.kind,
          confidence: item.confidence,
        });
      }
      return out;
    },
    get(id) {
      return proposals.get(id);
    },
    size() {
      return proposals.size;
    },
    resolve(id, action, content) {
      const proposal = proposals.get(id);
      if (!proposal) throw new Error("Memory proposal expired");
      if (action === "discard") {
        proposals.delete(id);
        return { ok: true, action: "discard" };
      }
      if (action === "edit" || action === "save") {
        const nextContent =
          action === "edit" && typeof content === "string"
            ? content.trim()
            : proposal.content;
        if (!nextContent) throw new Error("Memory is empty");
        if (SECRET.test(nextContent))
          throw new Error("Credentials cannot be stored");
        const item = {
          ...proposal,
          content: nextContent,
          setting:
            action === "edit" && nextContent !== proposal.content
              ? null
              : proposal.setting,
        };
        const committed = commitMemoryItem(store, item, proposal.chatId);
        proposals.delete(id);
        return {
          ok: true,
          action: action === "edit" ? "edit" : "save",
          id: committed.id,
          content: nextContent,
          preferences: committed.preferences,
        };
      }
      throw new Error("Invalid memory proposal action");
    },
  };
}

function similarText(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap >= 3 && overlap / Math.max(ta.size, tb.size) >= 0.6;
}

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function memoryCategory(kind, content = "") {
  if (kind === "preference") return "Preferences";
  if (kind === "lesson") return "Lessons";
  if (/^Uses |Windows|environment/i.test(content)) return "Environment";
  if (/^Project:/i.test(content)) return "Projects";
  if (
    /^Address preference|^App language|^Assistant language|Prefers /i.test(
      content,
    )
  )
    return "Preferences";
  return "About Me";
}
