/**
 * Bounded parsers for explicit security-tool targets.
 * Preserve the user's exact Windows path (including backslashes).
 */

export const SECURITY_BINARY_EXTENSIONS = Object.freeze([
  ".exe",
  ".dll",
  ".sys",
  ".ocx",
  ".cpl",
  ".scr",
  ".bin",
]);

const EXT_SET = new Set(SECURITY_BINARY_EXTENSIONS);
const TRAILING_PUNCT = /[.,;:)+\]!?]+$/;
const FILE_FOLLOW_UP =
  /(?:show|list|dump|print|get|extract)\s+(?:me\s+)?(?:its|the|this|that|same)\s+(?:imports?|exports?|sections?|headers?|strings?|hash(?:es)?|signature|entry\s*point)|(?:show|list)\s+(?:me\s+)?imports?|(?:extract|find|show)\s+strings\s+from\s+the\s+same\s+file|(?:same|that|this|the)\s+(?:file|binary|exe|dll)|its\s+(?:imports?|exports?|sections?|strings?|hash|signature)/i;

export function securityBinaryExtension(filePath = "") {
  const base = String(filePath).split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot).toLowerCase();
}

function isBinaryPath(filePath) {
  return EXT_SET.has(securityBinaryExtension(filePath));
}

function looksLikeFilePath(value) {
  const s = String(value || "");
  if (!s || /^https?:\/\//i.test(s)) return false;
  return /[\\/]/.test(s) || /^[A-Za-z]:/.test(s);
}

function trimPath(value) {
  return String(value || "").replace(TRAILING_PUNCT, "");
}

function resultFor(filePath) {
  const path = trimPath(filePath);
  if (!path || !isBinaryPath(path)) return null;
  return {
    path,
    extension: securityBinaryExtension(path),
    explicit: true,
  };
}

/**
 * Extract an explicit binary file target from the current user message.
 * Does not rewrite slashes or resolve the path.
 */
export function extractSecurityFileTarget(text = "") {
  const raw = String(text || "");
  if (!raw) return null;

  for (let i = 0; i < raw.length; i++) {
    const q = raw[i];
    if (q !== '"' && q !== "'") continue;
    const end = raw.indexOf(q, i + 1);
    if (end === -1) break;
    const inner = raw.slice(i + 1, end);
    if (looksLikeFilePath(inner)) {
      const hit = resultFor(inner);
      if (hit) return hit;
    }
    i = end;
  }

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (!/[A-Za-z]/.test(ch) || next !== ":") continue;
    const sep = raw[i + 2];
    if (sep !== "\\" && sep !== "/") continue;
    if (i > 0 && (raw[i - 1] === '"' || raw[i - 1] === "'")) continue;
    let end = i + 3;
    while (end < raw.length) {
      const cur = raw[end];
      if (/\s/.test(cur) || cur === '"' || cur === "'" || cur === "<" || cur === ">" || cur === "|")
        break;
      end++;
    }
    const hit = resultFor(raw.slice(i, end));
    if (hit) return hit;
    i = end;
  }

  if (raw.startsWith("\\\\") || raw.includes(" \\\\")) {
    const uncAt = raw.indexOf("\\\\");
    if (uncAt >= 0) {
      let end = uncAt + 2;
      while (end < raw.length) {
        const cur = raw[end];
        if (/\s/.test(cur) || cur === '"' || cur === "'") break;
        end++;
      }
      const hit = resultFor(raw.slice(uncAt, end));
      if (hit) return hit;
    }
  }

  return null;
}

export function extractSecurityProcessTarget(text = "") {
  const raw = String(text || "");
  const match =
    raw.match(/\bpid\s*[:=#]?\s*(\d{1,10})\b/i) ||
    raw.match(/\b(?:inspect|analyze|check)\s+pid\s+(\d{1,10})\b/i) ||
    raw.match(/\bprocess\s+(?:id\s+)?(\d{1,10})\b/i);
  if (!match) return null;
  return { pid: Number(match[1]), explicit: true };
}

export function isSecurityTargetFollowUp(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  if (extractSecurityFileTarget(t) || extractSecurityProcessTarget(t)) return false;
  return FILE_FOLLOW_UP.test(t);
}

export function formatSecurityToolFailure(tool, error) {
  const labels = {
    security_binary_inspect: "Binary inspection",
    security_strings: "String extraction",
    security_hash: "Hash comparison",
    security_yara_scan: "YARA scan",
    security_process_inspect: "Process inspection",
    security_network_snapshot: "Network snapshot",
    security_disassemble: "Disassembly",
    security_decompile: "Decompilation",
    security_packet_capture: "Packet capture",
    security_lab: "Security lab",
  };
  const label = labels[tool] || "Security tool";
  return `${label} failed: ${String(error || "unknown error").trim() || "unknown error"}.`;
}
