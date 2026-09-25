/**
 * Local Auto router + conversational intent + performance routing regressions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyTask, routeModel } from "../server/router.mjs";
import {
  classifyLocalTask,
  resolveLocalModelPlan,
  modelForLocalTask,
  keepAliveForModel,
} from "../server/local-models.mjs";
import {
  classifyConversationIntent,
  contextualizeUserText,
  shouldAttachVerification,
  resolveTurnContext,
} from "../server/conversation-intent.mjs";
import { buildChatRequest } from "../server/ollama.mjs";
import { shouldConsultCouncil, synthesizeFromEvidence } from "../server/council.mjs";

const fake = (models) => ({
  models: async () => Object.keys(models).map((name) => ({ name })),
  inspect: async (name) => ({
    capabilities: models[name],
    model_info: { "qwen3.context_length": 32768 },
  }),
});

test("yea does not trigger verification footer", () => {
  const intent = classifyConversationIntent("yea", {
    history: [
      { role: "user", content: "Should I refactor the router?" },
      { role: "assistant", content: "I can refactor it if you want." },
    ],
  });
  assert.equal(intent.intent, "confirm");
  assert.equal(intent.conversational, true);
  assert.equal(
    shouldAttachVerification({
      intent,
      text: "yea",
      evidencePack: {
        meaningful: true,
        research: { sources: [{ title: "t", url: "https://t.test" }] },
      },
      allowVerification: false,
    }),
    false,
  );
  const grounded = synthesizeFromEvidence({
    pack: { meaningful: true, inspection: { relevantFindings: "x" } },
    taskText: "yea",
  });
  assert.match(grounded, /No decisive verification/);
});

test("do it uses previous context", () => {
  const history = [
    { role: "user", content: "Please patch server/router.mjs" },
    { role: "assistant", content: "I can apply the patch now." },
  ];
  const turn = resolveTurnContext("do it", { history });
  assert.equal(turn.intent, "confirm");
  assert.match(turn.effectiveIntent, /apply the patch|patch/i);
  const expanded = contextualizeUserText("do it", history, turn);
  assert.match(expanded, /patch/i);
  assert.equal(
    classifyTask({
      text: "do it",
      history: [{ role: "user", content: "fix this CSS bug" }],
    }),
    "coding",
  );
});

test("simple chat and rewrite route to qwen3:8b", async () => {
  const installed = ["qwen3:14b", "deepseek-r1:14b", "qwen3:8b"];
  const plan = resolveLocalModelPlan(installed);
  assert.equal(plan.fast, "qwen3:8b");
  assert.equal(plan.general, "qwen3:8b");
  assert.equal(plan.strong, "qwen3:14b");
  assert.equal(plan.reasoning, "qwen3:14b");
  assert.equal(modelForLocalTask("general", plan), "qwen3:8b");
  assert.equal(modelForLocalTask("coding", plan), "qwen3:14b");
  assert.equal(classifyLocalTask({ text: "hi" }), "general");
  assert.equal(classifyLocalTask({ text: "rewrite this email" }), "general");
  assert.equal(classifyTask({ text: "fix this CSS" }), "coding");

  const ollama = fake({
    "qwen3:14b": ["tools"],
    "deepseek-r1:14b": ["thinking", "reasoning"],
    "qwen3:8b": ["tools"],
  });
  for (const text of ["hi", "yea", "thanks", "make it shorter"]) {
    const route = await routeModel({
      ollama,
      settings: { model: "qwen3:8b" },
      text,
      requestedModel: "auto",
      preferences: { remoteAi: "never" },
    });
    assert.equal(route.provider, "ollama");
    assert.equal(route.model, "qwen3:8b");
    assert.equal(route.kind, "general");
    assert.equal(route.profile.think, false);
    assert.equal(route.profile.keepAlive, "10m");
    assert.equal(route.profile.context, 4096);
  }
});

test("complex coding and debugging route to qwen3:14b", async () => {
  const ollama = fake({
    "qwen3:14b": ["tools"],
    "qwen3:8b": ["tools"],
    "deepseek-r1:14b": ["thinking", "reasoning"],
  });
  const coding = await routeModel({
    ollama,
    settings: { model: "qwen3:8b" },
    text: "fix this TypeScript bug in the router and add regression tests",
    requestedModel: "auto",
    preferences: { remoteAi: "never" },
  });
  assert.equal(coding.model, "qwen3:14b");
  assert.equal(coding.kind, "coding");
  assert.equal(coding.profile.keepAlive, "5m");
  assert.ok(coding.profile.context <= 8192);

  const hard = await routeModel({
    ollama,
    settings: { model: "qwen3:8b" },
    text: "inspect this project and find why this race condition happens",
    requestedModel: "auto",
    preferences: { remoteAi: "never" },
  });
  assert.equal(hard.model, "qwen3:14b");
  assert.equal(hard.kind, "hard_reasoning");
  assert.equal(hard.profile.keepAlive, "5m");
});

test("Jeddawi Auto prefers qwen3:14b for direct path; manual lock wins", async () => {
  const { shouldPreferJeddawiQuality } = await import(
    "../server/conversation-style.mjs"
  );
  const jeddawi = {
    language: "ar",
    arabic_style: "jeddawi",
    tone: "casual",
    verbosity: "normal",
  };
  assert.equal(shouldPreferJeddawiQuality(jeddawi, { intent: "task" }), true);
  assert.equal(
    shouldPreferJeddawiQuality(jeddawi, { intent: "greeting" }),
    false,
  );

  const ollama = fake({
    "qwen3:14b": ["tools"],
    "qwen3:8b": ["tools"],
  });
  const auto = await routeModel({
    ollama,
    settings: { model: "qwen3:8b" },
    text: "ايش رايك اروح النادي دحين ولا بعد العشا؟",
    requestedModel: "auto",
    preferences: { remoteAi: "never" },
    conversationStyle: jeddawi,
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
    conversationStyle: jeddawi,
    turnIntent: "task",
  });
  assert.equal(locked.model, "qwen3:8b");
  assert.equal(locked.reasonCode, "manual_lock");
});

test("failed 8b attempt escalates to 14b", () => {
  const plan = resolveLocalModelPlan(["qwen3:8b", "qwen3:14b"]);
  assert.equal(
    modelForLocalTask("general", plan, { previousFailures: ["qwen3:8b"] }),
    "qwen3:14b",
  );
  assert.equal(keepAliveForModel("qwen3:8b", "general"), "10m");
  assert.equal(keepAliveForModel("qwen3:14b", "coding"), "5m");
});

test("explicit model selection overrides Auto", async () => {
  const ollama = fake({
    "qwen3:14b": ["tools"],
    "deepseek-r1:14b": ["thinking"],
    "qwen3:8b": ["tools"],
  });
  const route = await routeModel({
    ollama,
    settings: { model: "qwen3:8b" },
    text: "hi",
    requestedModel: "qwen3:14b",
    preferences: { remoteAi: "never" },
  });
  assert.equal(route.model, "qwen3:14b");
  assert.equal(route.reasonCode, "manual_lock");
});

test("simple chat skips council research and verification", () => {
  const many = [
    { id: "qwen3:8b", provider: "ollama", local: true },
    { id: "qwen3:14b", provider: "ollama", local: true },
    { id: "other:7b", provider: "ollama", local: true },
  ];
  for (const text of ["hi", "yea", "ok", "thanks", "continue"]) {
    const turn = resolveTurnContext(text, {
      history: [
        { role: "user", content: "Should we refactor?" },
        { role: "assistant", content: "I can refactor the router." },
      ],
    });
    assert.equal(turn.fastPath, true);
    assert.equal(turn.allowResearch, false);
    assert.equal(turn.allowVerification, false);
    assert.equal(
      shouldConsultCouncil({
        text,
        availableModels: many,
        preferences: { councilMode: "auto" },
        taskKind: "general",
      }).consult,
      false,
    );
  }
  assert.equal(
    shouldConsultCouncil({
      text: "fix this CSS bug",
      availableModels: many,
      preferences: { councilMode: "auto" },
      taskKind: "coding",
    }).consult,
    false,
  );
});

test("local-only architecture never selects cloud providers by default", async () => {
  const ollama = fake({ "qwen3:8b": ["tools"] });
  const registry = {
    refresh: async () => {},
    listModels: ({ localOnly } = {}) => {
      const all = [
        {
          id: "qwen3:8b",
          provider: "ollama",
          local: true,
          capabilities: ["tools"],
        },
        {
          id: "gpt-4o",
          provider: "openai",
          local: false,
          capabilities: ["tools"],
        },
      ];
      return localOnly ? all.filter((m) => m.local) : all;
    },
    getProvider: () => ({}),
    getModelHealth: () => ({}),
  };
  const route = await routeModel({
    ollama,
    registry,
    settings: { model: "qwen3:8b" },
    text: "hello",
    requestedModel: "auto",
    preferences: {},
  });
  assert.equal(route.provider, "ollama");
  assert.equal(route.model, "qwen3:8b");
  assert.notEqual(route.provider, "openai");
});

test("chat request keeps think false and does not leak reasoning fields", () => {
  const body = buildChatRequest({
    model: "qwen3:14b",
    messages: [{ role: "user", content: "hi" }],
    profile: { think: false, keepAlive: "5m", context: 8192 },
  });
  assert.equal(body.think, false);
  assert.equal(body.keep_alive, "5m");
  assert.equal(Object.hasOwn(body, "reasoning"), false);
});

test("tiny casual messages never hard-reason", () => {
  for (const text of ["hi", "yea", "ok", "sure", "thanks"]) {
    assert.equal(classifyLocalTask({ text }), "general");
    assert.notEqual(classifyTask({ text }), "hard_reasoning");
  }
});
