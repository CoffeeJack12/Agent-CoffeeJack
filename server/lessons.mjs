import { validateMemory } from "./memory.mjs";

const SECRET =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-|gh[pousr]_|github_pat_|AKIA)|password\s*[:=]/i;

/**
 * Verified lessons — durable technical knowledge, never personal prefs as SYSTEM.
 */
export function createLessonCandidate({
  content,
  category = "workflow",
  verificationType = "none",
  evidence = [],
  confidence = 0.5,
  userId = null,
  project = null,
  sourceChatId = null,
} = {}) {
  return {
    content: String(content || "").trim(),
    category,
    verificationType,
    evidence: Array.isArray(evidence) ? evidence.slice(0, 10) : [],
    confidence,
    userId,
    project,
    sourceChatId,
    scope: project ? "project" : "private",
  };
}

export function shouldPersistLesson(candidate) {
  if (!candidate?.content || candidate.content.length < 12) return false;
  if (SECRET.test(candidate.content)) return false;
  if (candidate.confidence < 0.7) return false;
  if (candidate.verificationType === "none") return false;
  if (candidate.verificationType === "opinion") return false;
  if (
    candidate.verificationType === "tests" &&
    !candidate.evidence.some((e) => /test|pass|exit.?0/i.test(String(e)))
  )
    return false;
  if (
    candidate.verificationType === "sources" &&
    !candidate.evidence.some((e) => /https?:\/\//i.test(String(e)))
  )
    return false;
  if (
    candidate.verificationType === "tool" &&
    !candidate.evidence.length
  )
    return false;
  // User-stated workflow preference is allowed with verificationType user_statement
  if (
    candidate.verificationType === "user_statement" &&
    candidate.category === "workflow"
  )
    return candidate.confidence >= 0.8;
  return ["tests", "sources", "tool", "user_statement"].includes(
    candidate.verificationType,
  );
}

export function persistVerifiedLesson(store, candidate) {
  if (!shouldPersistLesson(candidate))
    return { saved: false, reason: "unverified_or_invalid" };
  const content = `[lesson:${candidate.category}] ${candidate.content}`.slice(
    0,
    2000,
  );
  try {
    validateMemory(content, "lesson");
  } catch (error) {
    return { saved: false, reason: error.message };
  }
  const id = store.remember(content, "lesson", candidate.project, {
    userId: candidate.userId,
    chatId: candidate.sourceChatId,
    confidence: candidate.confidence,
    category: candidate.category,
  });
  return { saved: true, id };
}

/** Extract a coding lesson after verified test success. */
export function lessonFromCodingSuccess({
  summary,
  testEvidence,
  userId,
  chatId,
  project,
}) {
  return createLessonCandidate({
    content: summary,
    category: "coding",
    verificationType: "tests",
    evidence: [testEvidence].filter(Boolean),
    confidence: 0.85,
    userId,
    project,
    sourceChatId: chatId,
  });
}
