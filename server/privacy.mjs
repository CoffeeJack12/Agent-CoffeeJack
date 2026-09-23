/**
 * Minimize sensitive material before any remote provider call.
 * Local Ollama traffic is unchanged; this filter is for remote prompts.
 */

const SECRET =
  /\b(?:sk-[a-zA-Z0-9]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._\-]{20,}|password\s*[:=]\s*\S+|api[_-]?key\s*[:=]\s*\S+)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi;

const SESSION =
  /\b(?:session[_-]?token|cookie|csrf|authorization)\s*[:=]\s*\S+/gi;

/**
 * Strip credentials and shrink oversized blobs for remote providers.
 * Returns { text, redacted, sensitive }.
 */
export function sanitizeForRemote(text = "", { maxChars = 24000 } = {}) {
  let out = String(text ?? "");
  let redacted = 0;
  const before = out;
  out = out.replace(SECRET, () => {
    redacted += 1;
    return "[redacted-secret]";
  });
  out = out.replace(SESSION, () => {
    redacted += 1;
    return "[redacted-session]";
  });
  const sensitive = redacted > 0 || before !== out;
  if (out.length > maxChars) out = out.slice(0, maxChars) + "\n…[truncated]";
  return { text: out, redacted, sensitive };
}

export function messagesForRemote(messages, options) {
  return (messages || []).map((message) => {
    if (typeof message?.content !== "string") return message;
    const { text } = sanitizeForRemote(message.content, options);
    return { ...message, content: text };
  });
}
