import test from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry } from "../server/providers/index.mjs";
import { routeModel } from "../server/router.mjs";
import {
  shouldConsultCouncil,
  selectCouncilParticipants,
  buildCouncilPlan,
  runCouncil,
  runCouncilEvidenceRound,
  councilUiSummary,
  MAX_ROUNDS,
} from "../server/council.mjs";
import {
  createLessonCandidate,
  shouldPersistLesson,
} from "../server/lessons.mjs";
import { sanitizeForRemote, messagesForRemote } from "../server/privacy.mjs";
import {
  createOpenAICompatibleProvider,
  createAnthropicProvider,
  createGoogleProvider,
} from "../server/providers/openai-compatible.mjs";

function fakeOllama(models = { "qwen3:8b": ["tools"] }) {
  return {
    models: async () =>
      Object.keys(models).map((name) => ({ name, capabilities: models[name] })),
    inspect: async (name) => ({
      capabilities: models[name] || [],
      model_info: { "general.context_length": 8192 },
    }),
    chat: async ({ model }) => ({ content: `local:${model}`, tokens: 1 }),
    unload: async () => {},
    prepare: async () => {},
  };
}

function mockRemote(id, modelList) {
  return {
    id,
    name: id,
    type: "remote",
    privacyClass: "remote",
    enabled: true,
    listModels: async () =>
      modelList.map((m) => ({
        id: m.id,
        capabilities: m.capabilities || ["tools", "reasoning"],
        local: false,
        costTier: "high",
        speedTier: "fast",
      })),
    health: async () => ({ available: true, latencyMs: 12 }),
    chat: async ({ model, signal }) => {
      signal?.throwIfAborted();
      if (modelList.find((m) => m.id === model)?.fail)
        throw new Error("timeout");
      return { content: `${id}:${model} proposal`, tokens: 2 };
    },
  };
}

test("provider-native council prefers distinct providers", () => {
  const models = [
    { id: "qwen3:8b", provider: "ollama", local: true, capabilities: ["tools"] },
    { id: "coder:7b", provider: "ollama", local: true, capabilities: ["tools"] },
    {
      id: "gpt-4o",
      provider: "openai",
      local: false,
      capabilities: ["tools", "reasoning"],
    },
    {
      id: "claude-sonnet-4-5",
      provider: "anthropic",
      local: false,
      capabilities: ["tools", "reasoning"],
    },
  ];
  const picked = selectCouncilParticipants(models, {
    max: 3,
    taskKind: "coding",
    preferences: { remoteAi: "allowed", remoteBudget: "balanced" },
  });
  assert.equal(picked.length, 3);
  const keys = new Set(picked.map((p) => `${p.providerId}:${p.modelId}`));
  assert.equal(keys.size, 3);
  const providers = new Set(picked.map((p) => p.providerId));
  assert.ok(providers.size >= 2, "should prefer multiple providers");
  assert.ok(!picked.every((p) => p.modelId === "qwen3:8b"));
});

test("council never duplicates same model as independent AIs", () => {
  const one = [
    { id: "qwen3:8b", provider: "ollama", local: true, capabilities: ["tools"] },
  ];
  assert.deepEqual(selectCouncilParticipants(one, { max: 3 }), []);
  const plan = buildCouncilPlan({
    text: "ask the council about architecture",
    preferences: { councilMode: "on" },
    availableModels: one,
  });
  assert.equal(plan.enabled, false);
  assert.match(plan.triggerReason, /one_model|insufficient/);
});

test("council other-models off with lock skips when only one locked model", () => {
  const models = [
    { id: "qwen3:8b", provider: "ollama", local: true },
    { id: "coder:7b", provider: "ollama", local: true },
  ];
  const picked = selectCouncilParticipants(models, {
    max: 2,
    lockedModel: "qwen3:8b",
    preferences: { councilOtherModels: "off", remoteAi: "never" },
  });
  assert.equal(picked.length, 0);
});

test("remote Never excludes remote council participants", () => {
  const models = [
    { id: "qwen3:8b", provider: "ollama", local: true },
    { id: "coder:7b", provider: "ollama", local: true },
    { id: "gpt-4o", provider: "openai", local: false },
  ];
  const picked = selectCouncilParticipants(models, {
    max: 3,
    preferences: { remoteAi: "never", remoteBudget: "performance" },
  });
  assert.ok(picked.every((p) => p.local !== false && p.providerId === "ollama"));
  assert.ok(!picked.some((p) => p.providerId === "openai"));
});

test("conservative budget limits remote participants to one", () => {
  const models = [
    { id: "qwen3:8b", provider: "ollama", local: true },
    { id: "gpt-4o", provider: "openai", local: false },
    { id: "claude-sonnet-4-5", provider: "anthropic", local: false },
  ];
  const picked = selectCouncilParticipants(models, {
    max: 3,
    preferences: { remoteAi: "allowed", remoteBudget: "conservative" },
  });
  assert.ok(picked.filter((p) => !p.local).length <= 1);
});

test("runCouncil uses registry adapters and survives partial timeout", async () => {
  const ollama = fakeOllama({
    "qwen3:8b": ["tools"],
    "coder:7b": ["tools"],
  });
  const registry = new ProviderRegistry({ ollama });
  registry.register(
    mockRemote("openai", [{ id: "gpt-4o", fail: true }]),
  );
  await registry.refresh();
  const participants = [
    {
      modelId: "qwen3:8b",
      providerId: "ollama",
      role: "primary",
      local: true,
    },
    {
      modelId: "gpt-4o",
      providerId: "openai",
      role: "critic",
      local: false,
    },
    {
      modelId: "coder:7b",
      providerId: "ollama",
      role: "specialist",
      local: true,
    },
  ];
  const result = await runCouncil({
    participants,
    prompt: "fix a difficult bug",
    registry,
  });
  assert.equal(result.skipped, false);
  assert.equal(result.requested, 3);
  assert.equal(result.succeeded, 2);
  assert.equal(result.rejected, 1);
  assert.ok(result.proposals.some((p) => p.status === "timeout" || p.status === "error"));
  assert.ok(result.synthesis.includes("primary"));
  const ui = councilUiSummary(result);
  assert.match(ui.detail, /2 models consulted/);
});

test("runCouncil goes through ProviderRegistry.chat not invented brands", async () => {
  const calls = [];
  const ollama = fakeOllama({ "qwen3:8b": ["tools"], "coder:7b": ["tools"] });
  const registry = new ProviderRegistry({ ollama });
  await registry.refresh();
  const original = registry.chat.bind(registry);
  registry.chat = async (opts) => {
    calls.push(opts.providerId + "/" + opts.modelId);
    return original(opts);
  };
  await runCouncil({
    participants: [
      { modelId: "qwen3:8b", providerId: "ollama", role: "primary", local: true },
      { modelId: "coder:7b", providerId: "ollama", role: "critic", local: true },
    ],
    prompt: "compare approaches",
    registry,
  });
  assert.deepEqual(calls.sort(), ["ollama/coder:7b", "ollama/qwen3:8b"].sort());
});

test("evidence round is bounded to MAX_ROUNDS", async () => {
  assert.equal(MAX_ROUNDS, 2);
  const second = await runCouncilEvidenceRound({
    priorRound: 1,
    participants: [
      { modelId: "a", providerId: "ollama", role: "primary" },
      { modelId: "b", providerId: "ollama", role: "critic" },
    ],
    prompt: "x",
    chatFn: async () => ({ content: "ok" }),
  });
  assert.equal(second.skipped, false);
  assert.equal(second.round, 2);
  const blocked = await runCouncilEvidenceRound({
    priorRound: 2,
    participants: second.proposals,
    prompt: "x",
    chatFn: async () => ({ content: "ok" }),
  });
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.reason, "max_rounds");
});

test("council participants never receive tools parameter via default registry path", async () => {
  let sawTools = false;
  const registry = {
    chat: async ({ tools }) => {
      if (tools?.length) sawTools = true;
      return { content: "plan" };
    },
    recordSuccess() {},
    recordFailure() {},
  };
  await runCouncil({
    participants: [
      { modelId: "a", providerId: "mock", role: "primary", local: true },
      { modelId: "b", providerId: "mock", role: "critic", local: true },
    ],
    prompt: "architecture",
    registry,
  });
  assert.equal(sawTools, false);
});

test("health cooldown deprioritizes failing models in router", async () => {
  const ollama = fakeOllama({
    "qwen3:8b": ["tools"],
    "backup:7b": ["tools"],
  });
  const registry = new ProviderRegistry({ ollama });
  await registry.refresh();
  for (let i = 0; i < 3; i++)
    registry.recordFailure("ollama", new Error("timeout"), "qwen3:8b");
  assert.equal(registry.getModelHealth("ollama", "qwen3:8b").inCooldown, true);
  const route = await routeModel({
    ollama,
    registry,
    settings: { model: "qwen3:8b" },
    text: "hello",
    preferences: { remoteAi: "never" },
  });
  assert.equal(route.model, "backup:7b");
});

test("council agreement alone is not verified lesson evidence", () => {
  assert.equal(
    shouldPersistLesson(
      createLessonCandidate({
        content: "Council agreed this patch is correct",
        verificationType: "opinion",
        evidence: ["council consensus"],
        confidence: 0.99,
      }),
    ),
    false,
  );
});

test("privacy minimizes remote council context", () => {
  const { text } = sanitizeForRemote(
    "Bearer sk-abcdefghijklmnopqrstuvwxyz session_token=abc cookie=x",
  );
  assert.ok(!/sk-abcdefghijklmnopqrstuvwxyz/.test(text));
  const msgs = messagesForRemote([
    { role: "user", content: "password: hunter2 and long ".repeat(2000) },
  ]);
  assert.ok(msgs[0].content.includes("[redacted") || msgs[0].content.length < 30000);
});

test("OpenAI/Anthropic/Google adapters normalize chat shape", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("openai") || u.includes("chat/completions")) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "openai-ok" } }],
          usage: { completion_tokens: 3 },
        }),
      };
    }
    if (u.includes("anthropic") || u.includes("/messages")) {
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "anthropic-ok" }],
          usage: { output_tokens: 2 },
        }),
      };
    }
    if (u.includes("generateContent") || u.includes("googleapis")) {
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "google-ok" }] } }],
          usageMetadata: { candidatesTokenCount: 1 },
        }),
      };
    }
    if (u.includes("/models")) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    return { ok: false, status: 404, text: async () => "no" };
  };
  process.env.OPENAI_API_KEY = "sk-test-openai";
  process.env.ANTHROPIC_API_KEY = "sk-test-anthropic";
  process.env.GOOGLE_API_KEY = "sk-test-google";
  try {
    const openai = createOpenAICompatibleProvider({
      id: "openai",
      name: "OpenAI",
      envKey: "OPENAI_API_KEY",
      defaultBaseUrl: "https://api.openai.com/v1",
    });
    const anthropic = createAnthropicProvider();
    const google = createGoogleProvider();
    const o = await openai.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    const a = await anthropic.chat({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    const g = await google.chat({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(o.content, "openai-ok");
    assert.equal(a.content, "anthropic-ok");
    assert.equal(g.content, "google-ok");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  }
});

test("provider auth error and malformed payload are normalized", async () => {
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => "unauthorized sk-test",
    });
    const openai = createOpenAICompatibleProvider({
      id: "openai",
      name: "OpenAI",
      envKey: "OPENAI_API_KEY",
      defaultBaseUrl: "https://api.openai.com/v1",
    });
    await assert.rejects(
      () =>
        openai.chat({
          model: "gpt-4o",
          messages: [{ role: "user", content: "x" }],
        }),
      /401|failed/i,
    );
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [] }),
    });
    const empty = await openai.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "x" }],
    });
    assert.equal(empty.content, "");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  }
});

test("trigger quality skips simple tasks and fires on architecture", () => {
  const many = [
    { id: "a", provider: "ollama", local: true },
    { id: "b", provider: "openai", local: false },
  ];
  assert.equal(
    shouldConsultCouncil({
      text: "hello",
      availableModels: many,
      preferences: { councilMode: "auto" },
    }).consult,
    false,
  );
  assert.equal(
    shouldConsultCouncil({
      text: "translate this sentence to Arabic",
      availableModels: many,
      preferences: { councilMode: "on" },
    }).consult,
    false,
  );
  assert.ok(
    shouldConsultCouncil({
      text: "compare approaches for this architecture carefully",
      availableModels: many,
      preferences: { councilMode: "auto" },
    }).consult,
  );
});

test("gaming suppresses council plan", () => {
  const plan = buildCouncilPlan({
    text: "ask the council",
    gaming: true,
    preferences: { councilMode: "on" },
    availableModels: [
      { id: "a", provider: "ollama", local: true },
      { id: "b", provider: "ollama", local: true },
    ],
  });
  assert.equal(plan.enabled, false);
  assert.equal(plan.triggerReason, "gaming");
});
