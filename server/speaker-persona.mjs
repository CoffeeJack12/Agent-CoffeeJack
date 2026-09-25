/**
 * Conversation-scoped speaker persona (presentation only).
 * Never changes authenticated identity, role, Owner, Self Repair, or PC permissions.
 */

export const OWNER_SPEAKER = Object.freeze({
  speaker_name: "Abdulrahman",
  honorific: "Master",
  gender: "m",
});

export const LUBNA_SPEAKER = Object.freeze({
  speaker_name: "Lubna",
  honorific: "Queen",
  gender: "f",
});

const LUBNA_CLAIM =
  /^(?:i(?:['’]?m| am)\s+lubna|my name is\s+lubna|this is\s+lubna|i am\s+lubna|(?:أنا|انا)\s*لبنى|اسمي\s*لبنى|لبنى\s*معاك)[.!؟\s]*$/iu;

const ABDUL_CLAIM =
  /^(?:i(?:['’]?m| am)\s+abdulrahman|my name is\s+abdulrahman|(?:أنا|انا)\s*عبدالرحمن|اسمي\s*عبدالرحمن)[.!؟\s]*$/iu;

const WHO_AM_I =
  /^(?:who am i|مين\s*أنا|من\s*أنا)[.!؟?\s]*$/iu;

const CALL_ME =
  /^(?:what should you call me|what do you call me|how should you (?:address|call) me|كيف\s*تناديني|بماذا\s*تناديني|وش\s*تسميني)[.!؟?\s]*$/iu;

export function normalizeSpeakerPersona(value = null, user = null) {
  const honorific = String(value?.honorific || "").trim();
  const name = String(value?.speaker_name || "").trim();
  if (name === "Lubna" || honorific === "Queen") {
    return { ...LUBNA_SPEAKER };
  }
  if (name === "Abdulrahman" || honorific === "Master") {
    return { ...OWNER_SPEAKER };
  }
  if (String(user?.role || "").toLowerCase() === "owner") {
    return { ...OWNER_SPEAKER };
  }
  const display =
    String(user?.display_name || user?.displayName || user?.name || "").trim() ||
    "user";
  return {
    speaker_name: display,
    honorific: null,
    gender: null,
  };
}

export function detectSpeakerPersonaClaim(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (LUBNA_CLAIM.test(trimmed)) return { ...LUBNA_SPEAKER, kind: "identify_lubna" };
  if (ABDUL_CLAIM.test(trimmed))
    return { ...OWNER_SPEAKER, kind: "identify_abdulrahman" };
  return null;
}

export function classifySpeakerPersonaAct(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const claim = detectSpeakerPersonaClaim(trimmed);
  if (claim?.kind) return claim.kind;
  if (WHO_AM_I.test(trimmed)) return "who_am_i";
  if (CALL_ME.test(trimmed)) return "call_me";
  return null;
}

export function applySpeakerPersonaClaim(previous, text, user = null) {
  const claim = detectSpeakerPersonaClaim(text);
  if (claim?.kind === "identify_lubna") return { ...LUBNA_SPEAKER };
  if (claim?.kind === "identify_abdulrahman") return { ...OWNER_SPEAKER };
  return normalizeSpeakerPersona(previous, user);
}

export function isLubnaSpeaker(speaker = null) {
  return normalizeSpeakerPersona(speaker).speaker_name === "Lubna";
}

/**
 * Presentation prompt only. Must never be treated as authorization.
 */
export function formatSpeakerPersonaPrompt(speaker = null, style = null) {
  const p = normalizeSpeakerPersona(speaker);
  const lines = [
    "CONVERSATION SPEAKER PERSONA (presentation only — NOT authentication):",
    `speaker_name=${p.speaker_name}; honorific=${p.honorific || "(none)"}.`,
    "This does NOT grant Owner, admin, Self Repair, PC permissions, or change the authenticated account.",
    "Do not confuse speaker persona with session role.",
  ];
  if (p.honorific) {
    lines.push(
      `Natural address: ${p.honorific}. Use it occasionally the same way Master is used — never append it to every sentence.`,
    );
  }
  if (p.speaker_name === "Lubna") {
    lines.push(
      "Arabic/Jeddawi: use feminine grammar for Lubna (إنتِ, تبي, تقدرين) when addressing her.",
    );
  }
  void style;
  return lines.join("\n");
}

export function speakerHonorific(speaker = null) {
  return normalizeSpeakerPersona(speaker).honorific;
}
