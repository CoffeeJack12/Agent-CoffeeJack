import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, "language", "worker.py");

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
  const mixed = /[A-Za-z]/.test(value) && /[\u0600-\u06ff]/u.test(value);
  return commandish && (hasLatin || mixed);
}

export async function enrichLanguageOnDemand(text = "", { force = false } = {}) {
  const fast = normalizeKnownLanguage(text);
  if (fast.changed || (!force && !shouldUseLanguageFallback(fast.text)))
    return { ...fast, source: fast.changed ? "fast_alias" : "none", fallbackMs: 0 };

  const cached = fallbackCache.get(fast.text);
  if (cached) return { ...cached, source: "cache", fallbackMs: 0 };
  const python = pythonExecutable();
  if (!python || !fs.existsSync(worker))
    return { ...fast, source: "none", fallbackMs: 0, unavailable: true };

  const started = Date.now();
  try {
    const { stdout } = await execFileAsync(python, [worker, fast.text], {
      windowsHide: true,
      timeout: 1500,
      maxBuffer: 64 * 1024,
    });
    const parsed = JSON.parse(String(stdout || "{}").trim() || "{}");
    const result = {
      original: fast.original,
      text: String(parsed.text || fast.text),
      changed: Boolean(parsed.changed) || String(parsed.text || fast.text) !== fast.original,
      changes: [...fast.changes, ...(Array.isArray(parsed.changes) ? parsed.changes : [])],
      source: "wordfreq",
      fallbackMs: Date.now() - started,
    };
    fallbackCache.set(fast.text, result);
    if (fallbackCache.size > 256) fallbackCache.delete(fallbackCache.keys().next().value);
    return result;
  } catch (error) {
    return {
      ...fast,
      source: "fallback_failed",
      fallbackMs: Date.now() - started,
      error: String(error?.message || error).slice(0, 200),
    };
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