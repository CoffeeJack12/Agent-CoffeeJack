/**
 * Jeddawi direct path + cheap guard + renderer fallback regressions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractProtectedSpans,
  restoreProtectedSpans,
  validateJeddawiRender,
  shouldInvokeJeddawiRenderer,
  renderJeddawiAnswer,
  guardJeddawiDirect,
  extractWindowsPaths,
  reattachProtectedSpans,
} from "../server/jeddawi-renderer.mjs";
import {
  JEDDAWI_RENDERER_MODEL,
  formatJeddawiStylePackPrompt,
} from "../server/styles/jeddawi.mjs";
import {
  shouldPreferJeddawiQuality,
  formatConversationStylePrompt,
  formatFinalOutputContract,
  isJeddawiActive,
  personaDeterministicReply,
} from "../server/conversation-style.mjs";
import { resolveTurnContext as resolveTurn } from "../server/conversation-intent.mjs";
import { routeModel } from "../server/router.mjs";

const JEDDAWI = {
  language: "ar",
  arabic_style: "jeddawi",
  tone: "casual",
  verbosity: "normal",
};

const fakeModels = (models) => ({
  models: async () => Object.keys(models).map((name) => ({ name })),
  inspect: async (name) => ({
    capabilities: models[name],
    model_info: { "qwen3.context_length": 32768 },
  }),
});

test("Auto Jeddawi direct path prefers qwen3:14b; manual lock wins", async () => {
  assert.equal(shouldPreferJeddawiQuality(JEDDAWI, { intent: "task" }), true);
  assert.equal(
    shouldPreferJeddawiQuality(JEDDAWI, { intent: "greeting" }),
    false,
  );
  assert.equal(
    shouldPreferJeddawiQuality(JEDDAWI, { priorityLane: "persona" }),
    true,
  );

  const ollama = fakeModels({
    "qwen3:14b": ["tools"],
    "qwen3:8b": ["tools"],
  });
  const auto = await routeModel({
    ollama,
    settings: { model: "qwen3:8b" },
    text: "ايش رايك اروح النادي؟",
    requestedModel: "auto",
    preferences: { remoteAi: "never" },
    conversationStyle: JEDDAWI,
    turnIntent: "task",
    fastPath: true,
  });
  assert.equal(auto.model, "qwen3:14b");
  assert.equal(auto.reasonCode, "jeddawi_quality");

  const locked = await routeModel({
    ollama,
    settings: { model: "qwen3:8b" },
    text: "ايش رايك اروح النادي؟",
    requestedModel: "qwen3:8b",
    preferences: { remoteAi: "never" },
    conversationStyle: JEDDAWI,
    turnIntent: "task",
  });
  assert.equal(locked.model, "qwen3:8b");
  assert.equal(locked.reasonCode, "manual_lock");
});

test("direct prompts include style pack; not semantic-draft-only", () => {
  const prompt = formatConversationStylePrompt(JEDDAWI);
  assert.match(prompt, /JEDDAWI|FINAL user-visible/i);
  assert.doesNotMatch(prompt, /SEMANTIC DRAFT MODE/);
  const contract = formatFinalOutputContract(JEDDAWI);
  assert.match(contract, /JEDDAWI STYLE PRINCIPLES|Naturalness/i);
  assert.match(formatJeddawiStylePackPrompt(), /demonstrations only|gist/i);
  assert.doesNotMatch(formatJeddawiStylePackPrompt(), /روح دحين إذا تقدر/);
});

test("cheap direct guard passes natural Jeddawi and fails contamination", () => {
  assert.equal(
    guardJeddawiDirect("إذا مو جوعان روح دحين وافتك.").ok,
    true,
  );
  assert.equal(guardJeddawiDirect("مفيش حاجة دحين.").ok, false);
  assert.equal(guardJeddawiDirect("عايز اروح النادي.").code, "forbidden");
  assert.equal(guardJeddawiDirect("Go after Duhin.").code, "transliteration");
  assert.equal(guardJeddawiDirect("").code, "empty");
  assert.equal(guardJeddawiDirect("I'm here.").code, "english");
  assert.equal(
    guardJeddawiDirect("خلّك تروح إذا ما حاببتش تتعشى.").code,
    "contamination",
  );
});

test("renderer invoked only as fallback helper; English/MSA skip", () => {
  assert.equal(shouldInvokeJeddawiRenderer(JEDDAWI), true);
  assert.equal(
    shouldInvokeJeddawiRenderer({ language: "en", arabic_style: "jeddawi" }),
    false,
  );
  assert.equal(
    shouldInvokeJeddawiRenderer({ language: "ar", arabic_style: "msa" }),
    false,
  );
});

test("same-turn ارجع جداوي activates Jeddawi for direct 14b path", () => {
  const turn = resolveTurn("ارجع جداوي وكمل نفس الموضوع", {
    previousStyle: {
      language: "en",
      arabic_style: "jeddawi",
      tone: "casual",
      verbosity: "normal",
    },
  });
  assert.equal(isJeddawiActive(turn.conversationStyle), true);
  assert.equal(shouldPreferJeddawiQuality(turn.conversationStyle, { intent: turn.intent }), true);
  assert.match(turn.stylePrompt, /JEDDAWI STYLE PRINCIPLES|Natural Jeddah|JEDDAWI/i);
});

test("renderer fallback: one attempt max then keep draft", async () => {
  let calls = 0;
  const fake = {
    chat: async () => {
      calls += 1;
      return { role: "assistant", content: "مفيش مشكلة", tokens: 1 };
    },
  };
  const draft = "يمكنك الذهاب إلى النادي الآن.";
  const result = await renderJeddawiAnswer({
    ollama: fake,
    draft,
    style: JEDDAWI,
  });
  assert.equal(calls, 1, "no retry loop");
  assert.equal(result.attempts, 1);
  assert.equal(result.fallback, true);
  assert.equal(result.text, draft);
});

test("paths and commands preserved through protect/restore + validate", () => {
  const draft = [
    "الملف:",
    String.raw`C:\Users\Abdul\CoffeeJack\server\index.mjs`,
    "والأمر:",
    "npm test",
  ].join("\n");
  const { masked, spans } = extractProtectedSpans(draft);
  const restored = restoreProtectedSpans(masked, spans);
  assert.equal(restored, draft);
  assert.ok(
    validateJeddawiRender(draft, restored + " — تمام.").ok,
  );
  assert.deepEqual(
    extractWindowsPaths(draft),
    extractWindowsPaths(restored),
  );
  const dropped = reattachProtectedSpans("الملف موجود.", draft);
  assert.match(dropped, /index\.mjs/);
  assert.match(dropped, /npm test/);
});

test("persona deterministic bypasses expensive generation", () => {
  const owner = { role: "owner", display_name: "Abdulrahman" };
  assert.equal(
    personaDeterministicReply(JEDDAWI, owner, "who_master"),
    "إنت يا عبدالرحمن، Master.",
  );
});

test("renderer model constant is 14b", () => {
  assert.equal(JEDDAWI_RENDERER_MODEL, "qwen3:14b");
});
