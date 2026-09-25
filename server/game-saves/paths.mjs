import path from "node:path";

const SENSITIVE_KEYS =
  /content|message|body|password|secret|token|code|credential|save.?data|buffer|bytes/i;

export function redactPath(filePath) {
  if (!filePath || typeof filePath !== "string") return filePath ?? null;
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return `…/${parts.slice(-2).join("/")}`;
}

export function redactEvidence(value, key = "") {
  if (SENSITIVE_KEYS.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactEvidence(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([name, item]) => [
          name,
          /path|dir|root|install/i.test(name)
            ? redactPath(String(item ?? ""))
            : redactEvidence(item, name),
        ]),
    );
  }
  if (typeof value === "string" && /[\\/]/.test(value) && value.length > 40)
    return redactPath(value);
  if (typeof value === "string") return value.slice(0, 240);
  return value;
}

export function isInsideDir(filePath, root) {
  if (!filePath || !root) return false;
  const resolved = path.resolve(filePath);
  const base = path.resolve(root);
  const rel = path.relative(base, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function uniqueTimestampName(prefix, ext = ".sav") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(16).slice(2, 8);
  return `${prefix}-${stamp}-${rand}${ext}`;
}
