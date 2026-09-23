import path from "node:path";

export function projectKey(project) {
  if (!project) return null;
  if (typeof project !== "string") throw new Error("Invalid memory project");
  const normalized = path.resolve(project);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function validateMemory(content, kind) {
  if (typeof content !== "string" || !content.trim() || content.length > 8000)
    throw new Error("Memory must contain 1 to 8000 characters");
  if (!["note", "preference", "lesson"].includes(kind))
    throw new Error("Invalid memory kind");
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{16,}|github_pat_[a-zA-Z0-9_]{16,}|AKIA[A-Z0-9]{16})|\bBearer\s+[\w.~-]{12,}|\b(?:password|passwd|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*\S+|كلمة\s*(?:المرور|السر)\s*[:=]\s*\S+|https?:\/\/[^\s/@]+:[^\s/@]+@/i.test(
      content,
    )
  )
    throw new Error("Credentials and secrets cannot be stored in memory");
  return content.trim();
}

const stopWords = new Set(
  "the a an to of in and or is it this that with for my me please use what how I you on at from من في على عن الى إلى هذا هذه هو هي انا أنا لي مع و يا"
    .toLowerCase()
    .split(" "),
);
export function memoryTerms(text) {
  return [
    ...new Set(
      (
        String(text)
          .toLowerCase()
          .match(/[\p{L}\p{N}_]+/gu) ?? []
      ).filter((word) => word.length > 1 && !stopWords.has(word)),
    ),
  ].slice(0, 24);
}

export function retrieveMemories(
  db,
  query,
  { project, limit = 8, maxChars = 4000 } = {},
) {
  const terms = memoryTerms(query);
  const scope = projectKey(project);
  const score =
    terms
      .map(
        () => "CASE WHEN lower(content) LIKE ? ESCAPE '\\' THEN 10 ELSE 0 END",
      )
      .join(" + ") || "0";
  const patterns = terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
  const candidates = db
    .prepare(
      `SELECT *, (${score}) AS relevance FROM memories
    WHERE project IS NULL OR project = ?
    ORDER BY relevance DESC, CASE WHEN project = ? THEN 1 ELSE 0 END DESC,
    CASE WHEN kind = 'preference' THEN 1 ELSE 0 END DESC, created DESC LIMIT 80`,
    )
    .all(...patterns, scope, scope);
  const selected = [];
  let used = 0;
  for (const memory of candidates) {
    if (
      !memory.relevance &&
      memory.kind !== "preference" &&
      !(scope && memory.project === scope)
    )
      continue;
    try {
      validateMemory(memory.content, memory.kind);
    } catch {
      continue;
    }
    const content = memory.content.slice(0, 1000);
    if (used + content.length > maxChars) continue;
    used += content.length;
    selected.push({
      id: memory.id,
      content,
      kind: memory.kind,
      project: memory.project,
    });
    if (selected.length >= Math.min(12, Math.max(1, limit))) break;
  }
  return selected;
}
