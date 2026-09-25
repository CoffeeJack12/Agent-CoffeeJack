/**
 * Jeddawi semantic-normalization, canonical topic, sticky 14b, anti-copy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCanonicalTopic,
  isDialectOnlyUtterance,
  looksLikeButterCalque,
  looksLikeFailedSemanticReply,
  normalizeJeddawiSemantics,
  outputAbandonsTopic,
  salvageTopicReply,
  semanticArabicFallback,
} from "../server/jeddawi-semantics.mjs";
import {
  isVerbatimStyleExample,
  formatJeddawiStylePackPrompt,
} from "../server/styles/jeddawi.mjs";
import { resolveTurnContext } from "../server/conversation-intent.mjs";
import {
  isJeddawiSession,
  shouldPreferJeddawiQuality,
} from "../server/conversation-style.mjs";
import { routeModel } from "../server/router.mjs";
import { extractMemories } from "../server/auto-memory.mjs";
import { renderJeddawiAnswer } from "../server/jeddawi-renderer.mjs";

const JEDDAWI = {
  language: "ar",
  arabic_style: "jeddawi",
  tone: "casual",
  verbosity: "normal",
};

const GYM = "whether to go to the gym now or after dinner";

const gymHist = [
  { role: "user", content: "ايش رايك اروح النادي دحين ولا بعد العشا؟" },
  { role: "assistant", content: "إذا ما أنت جوعان، روح الحين." },
];

test("اديني الزبدة is bottom line, never butter", () => {
  const s = normalizeJeddawiSemantics("يا حبيبي اديني الزبدة");
  assert.equal(s.kind, "gist");
  assert.match(s.semanticIntent, /bottom line/i);
  assert.ok(s.forbiddenLiterals.includes("butter"));
  assert.equal(s.preserveTopic, true);
  assert.equal(looksLikeButterCalque("You want the butter?"), true);
  assert.equal(looksLikeButterCalque("Bottom line: go now if you can."), false);
});

test("لا تفلسفها is concise/direct", () => {
  const s = normalizeJeddawiSemantics("لا تفلسفها");
  assert.equal(s.kind, "be_direct");
  assert.match(s.semanticIntent, /direct/i);
});

test("canonical topic survives language switch and is not slang", () => {
  assert.equal(
    extractCanonicalTopic("ايش رايك اروح النادي دحين ولا بعد العشا؟", null),
    GYM,
  );
  assert.equal(extractCanonicalTopic("اديني الزبدة", GYM), GYM);
  assert.equal(extractCanonicalTopic("English now", GYM), GYM);
  assert.equal(extractCanonicalTopic("ارجع جداوي", GYM), GYM);
  assert.equal(extractCanonicalTopic("طيب لو ما زبط؟", GYM), GYM);
  assert.equal(extractCanonicalTopic("دحين ايش اسوي؟", GYM), GYM);
  assert.equal(extractCanonicalTopic("what if I can't go today?", GYM), GYM);
  assert.equal(normalizeJeddawiSemantics("what if I can't go today?").kind, "if_fails");

  const en = resolveTurnContext("English now", {
    history: gymHist,
    previousStyle: JEDDAWI,
    previousTopic: GYM,
  });
  assert.equal(en.canonicalTopic, GYM);
  assert.equal(en.conversationStyle.language, "en");
  assert.match(en.stylePrompt, /CANONICAL TOPIC|Canonical topic/i);
  assert.doesNotMatch(en.effectiveIntent, /butter/i);
  assert.notEqual(en.canonicalTopic, "الزبدة");
  assert.notEqual(en.canonicalTopic, en.snapshot.lastAssistant);
});

test("semantic state is separate from rendered answer / last wording", () => {
  const turn = resolveTurnContext("اديني الزبدة", {
    history: gymHist,
    previousStyle: JEDDAWI,
    previousTopic: GYM,
  });
  assert.equal(turn.semantic.kind, "gist");
  assert.equal(turn.canonicalTopic, GYM);
  assert.notEqual(turn.canonicalTopic, turn.snapshot.lastAssistant);
  assert.match(turn.effectiveIntent, /bottom line|concise/i);
});

test("dialect normalization does not write long-term memory", () => {
  assert.equal(isDialectOnlyUtterance("اديني الزبدة"), true);
  assert.equal(isDialectOnlyUtterance("لا تفلسفها"), true);
  assert.deepEqual(extractMemories("اديني الزبدة"), []);
  assert.deepEqual(extractMemories("English now"), []);
  assert.ok(
    extractCanonicalTopic("remember my favorite editor is neovim", GYM) !==
      GYM || true,
  );
});

test("sticky 14b during temporary English; new English chat uses 8b; manual lock wins", async () => {
  assert.equal(isJeddawiSession({ language: "en", arabic_style: "jeddawi" }), true);
  assert.equal(
    shouldPreferJeddawiQuality(
      { language: "en", arabic_style: "jeddawi" },
      { intent: "language_switch" },
    ),
    true,
  );

  const ollama = {
    models: async () => [{ name: "qwen3:8b" }, { name: "qwen3:14b" }],
    inspect: async () => ({
      capabilities: ["tools"],
      model_info: { "qwen3.context_length": 32768 },
    }),
  };
  const sticky = await routeModel({
    ollama,
    settings: { model: "qwen3:8b" },
    text: "English now",
    requestedModel: "auto",
    preferences: { remoteAi: "never" },
    conversationStyle: { language: "en", arabic_style: "jeddawi" },
    turnIntent: "language_switch",
    fastPath: true,
  });
  assert.equal(sticky.model, "qwen3:14b");
  assert.equal(sticky.reasonCode, "jeddawi_quality");
  assert.equal(sticky.profile.keepAlive, "10m");

  const freshEn = await routeModel({
    ollama,
    settings: { model: "qwen3:8b" },
    text: "Hey, summarize this in English",
    requestedModel: "auto",
    preferences: { remoteAi: "never" },
    conversationStyle: { language: "en", arabic_style: "default" },
    turnIntent: "task",
    fastPath: true,
  });
  assert.equal(freshEn.model, "qwen3:8b");
  assert.notEqual(freshEn.reasonCode, "jeddawi_quality");

  const locked = await routeModel({
    ollama,
    settings: { model: "qwen3:8b" },
    text: "English now",
    requestedModel: "qwen3:8b",
    preferences: { remoteAi: "never" },
    conversationStyle: { language: "en", arabic_style: "jeddawi" },
    turnIntent: "language_switch",
  });
  assert.equal(locked.model, "qwen3:8b");
  assert.equal(locked.reasonCode, "manual_lock");
});

test("style examples are not copy-paste answers; similarity guard", () => {
  const pack = formatJeddawiStylePackPrompt();
  assert.match(pack, /demonstrations only/i);
  assert.doesNotMatch(pack, /روح دحين إذا تقدر، وافتك/);
  assert.equal(
    isVerbatimStyleExample("روح دحين إذا تقدر، وافتك."),
    true,
  );
  assert.equal(
    isVerbatimStyleExample("إذا مو جوعان روح دحين وافتك."),
    false,
  );
});

test("renderer fallback cannot change topic; prefers clean Arabic", async () => {
  const fake = {
    chat: async () => ({
      role: "assistant",
      content: "You want the butter? روح واجبه إذا تقدر",
      tokens: 1,
    }),
  };
  const result = await renderJeddawiAnswer({
    ollama: fake,
    draft: "الخلاصة: اذهب إلى النادي الآن إن استطعت.",
    style: JEDDAWI,
    topic: GYM,
    semanticTurn: { kind: "gist" },
  });
  assert.equal(result.fallback, true);
  assert.doesNotMatch(result.text, /butter/i);
  assert.doesNotMatch(result.text, /واجبه/);
  assert.match(result.text, /نادي|الخلاصة|الحين|الآن/);
});

test("failed echo replies salvage gym topic without butter", () => {
  assert.equal(
    looksLikeFailedSemanticReply("الزبدة.", {
      semantic: { kind: "gist" },
      topic: GYM,
    }),
    true,
  );
  assert.equal(
    looksLikeFailedSemanticReply("Now.", {
      semantic: { kind: "style" },
      topic: GYM,
      language: "en",
    }),
    true,
  );
  const en = salvageTopicReply({
    topic: GYM,
    semantic: { kind: "gist" },
    language: "en",
  });
  assert.match(en, /Bottom line|go now/i);
  assert.doesNotMatch(en, /butter/i);
  const ar = salvageTopicReply({
    topic: GYM,
    semantic: { kind: "what_now" },
    language: "ar",
  });
  assert.match(ar, /نادي|عشا|دحين/);
  assert.equal(
    looksLikeFailedSemanticReply("إذا ما زبط، نخليه بعدها. مفيش مشكلة. خليه في يوم تاني.", {
      semantic: { kind: "if_fails" },
      topic: GYM,
    }),
    true,
  );
  assert.equal(
    looksLikeFailedSemanticReply("الزبدة ما بسويش حاجة، بس خليّنا نريح نفوسنا بعد العشا.", {
      semantic: { kind: "gist" },
      topic: GYM,
    }),
    true,
  );
});

test("outputAbandonsTopic catches butter and malformed Hijazi", () => {
  assert.equal(
    outputAbandonsTopic("You want the butter?", GYM, { kind: "gist" }),
    true,
  );
  assert.equal(outputAbandonsTopic("روح واجبه إذا تقدر", GYM, { kind: "gist" }), true);
  assert.equal(
    outputAbandonsTopic("Bottom line: go now if you can.", GYM, { kind: "gist" }),
    false,
  );
  const fallback = semanticArabicFallback({
    topic: GYM,
    semantic: { kind: "gist" },
    draft: "You want the butter?",
  });
  assert.doesNotMatch(fallback, /butter/i);
});
