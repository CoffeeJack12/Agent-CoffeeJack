/**
 * Deterministic instant replies for pure greetings.
 * Must never call Ollama, Council, research, memory retrieval, or tools.
 */

import {
  accountBoundSpeaker,
  isMasterAccount,
  isQueenAccount,
} from "./account-personas.mjs";

const AFFECTION_VOCATIVE_RE = /^يا\s*(?:حب|حبي|حبيبي|قلبي|بعدي|روحي)[.!؟?~\s]*$/u;
const FRIENDLY_VOCATIVE_RE = /^يا\s*(?:وحش|رجال|جاك)[.!؟?~\s]*$/u;

export const PURE_GREETING_RE =
  /^(?:hey(?:\s+jack)?|hi|hello|السلام عليكم|هلا|هاي|يا\s*(?:حب|حبي|حبيبي|قلبي|بعدي|روحي|وحش|رجال|جاك))[.!؟?~\s]*$/iu;

function stripArabicMarks(text) {
  return String(text || "").replace(/[\u064B-\u0652\u0670\u0640]/gu, "").trim();
}

export function isPureGreeting(text = "") {
  const trimmed = stripArabicMarks(text);
  if (!trimmed || trimmed.length > 40) return false;
  return PURE_GREETING_RE.test(trimmed);
}

export function greetingDeterministicReply({
  user = null,
  text = "",
  store = null,
} = {}) {
  const trimmed = stripArabicMarks(text);
  if (AFFECTION_VOCATIVE_RE.test(trimmed)) return "هلا يا حب، وش عندك؟";
  if (FRIENDLY_VOCATIVE_RE.test(trimmed)) return "هلا، وش عندك؟";

  if (isQueenAccount(user, store)) return "At your service, Queen.";
  if (isMasterAccount(user)) return "At your service, Master.";
  if (/^السلام عليكم[.!؟?~\s]*$/u.test(trimmed)) return "وعليكم السلام.";
  if (/^هلا[.!؟?~\s]*$/u.test(trimmed)) return "هلا.";
  if (/^هاي[.!؟?~\s]*$/u.test(trimmed)) return "هاي.";
  if (/^hi[.!?\s]*$/i.test(trimmed)) return "Hi.";
  if (/^hello[.!?\s]*$/i.test(trimmed)) return "Hello.";
  return "Hey.";
}

export function emitInstantGreeting({
  store,
  chatId,
  user,
  text,
  emit,
  timing = null,
}) {
  const speakerPersona = accountBoundSpeaker(user, store);
  const reply = greetingDeterministicReply({ user, text, store });
  const previousState = store.taskState(chatId) || {};
  store.saveTaskState(chatId, { ...previousState, speakerPersona });
  store.message(chatId, "user", text);
  store.message(chatId, "assistant", reply);
  emit({
    type: "priority",
    lane: "greeting",
    intent: "greeting",
    personaKind: null,
    fastPath: true,
    instantGreeting: true,
  });
  emit({
    type: "turn_context",
    intent: "greeting",
    taskHint: null,
    fastPath: true,
    instantGreeting: true,
    effectiveIntent: String(text || "").slice(0, 400),
    speakerPersona,
    allowResearch: false,
    allowVerification: false,
    allowMemoryWrite: false,
    allowWebSearch: false,
    allowMemoryRecall: false,
  });
  emit({ type: "token", text: reply });
  emit({ type: "done", tokens: 0 });
  if (timing?.snapshot) {
    emit({
      type: "timing",
      ...timing.snapshot({
        model: null,
        kind: "greeting",
        fastPath: true,
      }),
    });
  }
  return reply;
}
