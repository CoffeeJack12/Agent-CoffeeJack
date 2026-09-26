import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderRegistry, createDefaultRegistry } from "../server/providers/index.mjs";
import { createOllamaProvider } from "../server/providers/ollama-provider.mjs";
import { createOpenAICompatibleProvider } from "../server/providers/openai-compatible.mjs";
import { routeModel } from "../server/router.mjs";
import {
  shouldConsultCouncil,
  selectCouncilParticipants,
  runCouncil,
  councilUiSummary,
} from "../server/council.mjs";
import {
  createLessonCandidate,
  shouldPersistLesson,
  persistVerifiedLesson,
  lessonFromCodingSuccess,
} from "../server/lessons.mjs";
import { sanitizeForRemote } from "../server/privacy.mjs";
import { Store } from "../server/store.mjs";
import {
  getPreferences,
  savePreferences,
  DEFAULT_PREFERENCES,
} from "../server/preferences.mjs";
import { createUser, resolveLocalOwner } from "../server/users.mjs";

function fakeOllama(models = { "qwen3:8b": ["tools"] }) {
  return {
    models: async () =>
      Object.keys(models).map((name) => ({ name, capabilities: models[name] })),
    inspect: async (name) => ({
      capabilities: models[name] || [],
      model_info: { "qwen3.context_length": 8192 },
    }),
    chat: async () => ({ content: "ok", tokens: 1 }),
    unload: async () => {},
    prepare: async () => {},
  };
}

test("ProviderRegistry registers Ollama and discovers models", async () => {
  const ollama = fakeOllama({
    "qwen3:8b": ["tools"],
    "llava:7b": ["vision"],
  });
  const registry = new ProviderRegistry({ ollama });
  assert.equal(registry.getProvider("ollama").id, "ollama");
  await registry.refresh();
  const providers = registry.listProviders();
  assert.ok(providers.some((p) => p.id === "ollama" && p.available));
  const models = registry.listModels();
  assert.ok(models.some((m) => m.id === "qwen3:8b" && m.local));
  assert.ok(models.some((m) => m.id === "llava:7b"));
  registry.recordFailure("ollama", new Error("timeout"));
  assert.ok(registry.listProviders().find((p) => p.id === "ollama").failures >= 1);
  registry.recordSuccess("ollama");
  assert.ok(registry.listProviders().find((p) => p.id === "ollama").successes >= 1);
});

test("createDefaultRegistry includes remote adapters without requiring keys", () => {
  const registry = createDefaultRegistry(fakeOllama());
  const ids = registry.listProviders().map((p) => p.id);
  assert.deepEqual(
    ids.filter((id) => ["ollama", "openai", "anthropic", "google", "groq"].includes(id)).sort(),
    ["anthropic", "google", "groq", "ollama", "openai"],
  );
  assert.equal(registry.getProvider("openai").enabled, false);
});

test("remote providers expose no models when API key missing", async () => {
  const provider = createOpenAICompatibleProvider({
    id: "openai",
    name: "OpenAI",
    envKey: "COFFEEJACK_TEST_MISSING_KEY",
    defaultBaseUrl: "https://api.openai.com/v1",
  });
  assert.equal(provider.enabled, false);
  assert.deepEqual(await provider.listModels(), []);
  const health = await provider.health();
  assert.equal(health.available, false);
});

test("router selects local fast model for simple chat", async () => {
  const ollama = fakeOllama({ "qwen3:8b": ["tools"] });
  const registry = new ProviderRegistry({ ollama });
  await registry.refresh();
  const route = await routeModel({
    ollama,
    registry,
    settings: { model: "qwen3:8b" },
    text: "hello Jack",
    requestedModel: "auto",
    preferences: { remoteAi: "allowed", remoteBudget: "conservative" },
  });
  assert.equal(route.model, "qwen3:8b");
  assert.equal(route.provider, "ollama");
  assert.equal(route.reasonCode, "local_fast");
  assert.equal(route.needsRemoteApproval, false);
});

test("router prefers coding-capable and respects manual lock", async () => {
  const ollama = fakeOllama({
    "qwen3:8b": ["tools"],
    "coder:7b": ["tools", "thinking"],
  });
  const registry = new ProviderRegistry({ ollama });
  await registry.refresh();
  const coding = await routeModel({
    ollama,
    registry,
    settings: { model: "qwen3:8b", codingModel: "coder:7b" },
    text: "refactor this repository carefully",
    requestedModel: "auto",
    effectiveMode: "developer",
    preferences: { remoteAi: "never" },
  });
  assert.equal(coding.model, "coder:7b");
  assert.equal(coding.reasonCode, "coding_capable");

  const locked = await routeModel({
    ollama,
    registry,
    settings: { model: "qwen3:8b" },
    text: "refactor this repository",
    requestedModel: "qwen3:8b",
    preferences: { remoteAi: "never" },
  });
  assert.equal(locked.model, "qwen3:8b");
  assert.equal(locked.reasonCode, "manual_lock");
});

test("router vision, gaming, remote Never, and Ask approval flags", async () => {
  const ollama = fakeOllama({
    "qwen3:8b": ["tools"],
    "llava:7b": ["vision"],
  });
  const remote = {
    id: "openai",
    name: "OpenAI",
    type: "remote",
    privacyClass: "remote",
    enabled: true,
    listModels: async () => [
      {
        id: "gpt-4o",
        capabilities: ["tools", "vision", "coding"],
        local: false,
        costTier: "high",
        speedTier: "fast",
      },
    ],
    health: async () => ({ available: true }),
  };
  const registry = new ProviderRegistry({ ollama });
  registry.register(remote);
  await registry.refresh();

  const vision = await routeModel({
    ollama,
    registry,
    settings: { model: "qwen3:8b", visionModel: "llava:7b" },
    text: "describe",
    attachments: ["uploads/a.png"],
    preferences: { remoteAi: "allowed" },
  });
  assert.equal(vision.kind, "vision");
  assert.equal(vision.reasonCode, "vision_required");

  const never = await routeModel({
    ollama,
    registry,
    settings: { model: "qwen3:8b" },
    text: "write complex code",
    requestedModel: "auto",
    preferences: { remoteAi: "never", remoteBudget: "performance" },
  });
  assert.equal(never.provider, "ollama");
  assert.notEqual(never.provider, "openai");

  const gaming = await routeModel({
    ollama,
    registry,
    settings: { model: "qwen3:8b" },
    text: "hello",
    gaming: true,
    preferences: { remoteAi: "allowed" },
  });
  assert.equal(gaming.provider, "ollama");
  assert.equal(gaming.reasonCode, "gaming_fallback");

  // Mock remote as only coding candidate by previousFailures of local
  const ask = await routeModel({
    ollama,
    registry,
    settings: { model: "missing-local" },
    text: "hello",
    requestedModel: "gpt-4o",
    preferences: { remoteAi: "ask" },
    previousFailures: [],
  });
  assert.equal(ask.provider, "openai");
  assert.equal(ask.needsRemoteApproval, true);
});

test("router fallbackModels after preferred failure list", async () => {
  const ollama = fakeOllama({
    "qwen3:8b": ["tools"],
    "backup:7b": ["tools"],
  });
  const registry = new ProviderRegistry({ ollama });
  await registry.refresh();
  const route = await routeModel({
    ollama,
    registry,
    settings: { model: "backup:7b" },
    text: "hi",
    previousFailures: ["backup:7b"],
    preferences: { remoteAi: "never" },
  });
  assert.equal(route.model, "qwen3:8b");
  assert.equal(route.reasonCode, "fallback_after_failure");
});

test("council skips with one model and respects off/gaming", () => {
  const one = [{ id: "qwen3:8b", provider: "ollama", local: true }];
  assert.equal(
    shouldConsultCouncil({
      text: "ask the council about architecture",
      availableModels: one,
      preferences: { councilMode: "on" },
    }).consult,
    false,
  );
  assert.equal(
    shouldConsultCouncil({
      text: "ask the council",
      availableModels: one,
    }).reason,
    "one_model_available",
  );
  assert.equal(
    shouldConsultCouncil({
      text: "refactor the entire architecture carefully",
      availableModels: [
        ...one,
        { id: "coder:7b", provider: "ollama", local: true },
      ],
      preferences: { councilMode: "off" },
    }).consult,
    false,
  );
  assert.equal(
    shouldConsultCouncil({
      text: "ask the council",
      availableModels: [
        ...one,
        { id: "coder:7b", provider: "ollama", local: true },
      ],
      gaming: true,
    }).consult,
    false,
  );
  assert.equal(
    shouldConsultCouncil({ text: "hello", availableModels: [...one, { id: "b", provider: "ollama" }] })
      .consult,
    false,
  );
  assert.ok(
    shouldConsultCouncil({
      text: "ask the council about this design",
      availableModels: [
        ...one,
        { id: "coder:7b", provider: "ollama", local: true },
      ],
      preferences: { councilMode: "auto" },
    }).consult,
  );
});

test("council bounds participants and does not invent brands", async () => {
  const models = [
    { id: "qwen3:8b", provider: "ollama", local: true },
    { id: "coder:7b", provider: "ollama", local: true },
    { id: "gpt-4o", provider: "openai", local: false },
  ];
  const picked = selectCouncilParticipants(models, { max: 2 });
  assert.equal(picked.length, 2);
  assert.equal(picked[0].role, "primary");
  assert.equal(picked[1].role, "critic");
  const result = await runCouncil({
    participants: picked,
    prompt: "fix a difficult bug",
    chatFn: async ({ model }) => ({ content: `plan from ${model}` }),
  });
  assert.equal(result.skipped, false);
  assert.equal(result.modelsConsulted, 2);
  const ui = councilUiSummary(result);
  assert.match(ui.detail, /2 models consulted/);
  const skip = councilUiSummary({ skipped: true, reason: "one_model_available" });
  assert.match(skip.detail, /1 model available/);
});

test("council run with provider failure still synthesizes remaining", async () => {
  const result = await runCouncil({
    participants: [
      { id: "a", provider: "ollama", role: "primary" },
      { id: "b", provider: "ollama", role: "critic" },
    ],
    prompt: "compare approaches",
    chatFn: async ({ model }) => {
      if (model === "b") throw new Error("timeout");
      return { content: "primary plan" };
    },
  });
  assert.equal(result.modelsConsulted, 1);
  assert.equal(result.rejected, 1);
});

test("verified lessons require evidence and reject secrets", () => {
  assert.equal(
    shouldPersistLesson(
      createLessonCandidate({
        content: "Use exact-context patches",
        verificationType: "none",
      }),
    ),
    false,
  );
  assert.equal(
    shouldPersistLesson(
      createLessonCandidate({
        content: "password: hunter2",
        verificationType: "tests",
        evidence: ["tests passed"],
        confidence: 0.9,
      }),
    ),
    false,
  );
  assert.ok(
    shouldPersistLesson(
      lessonFromCodingSuccess({
        summary: "Prefer unique apply_patch contexts",
        testEvidence: "run_tests exit 0 pass",
        userId: "u1",
      }),
    ),
  );
});

test("lessons persist privately and dedupe via store memory", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-lessons-"));
  const store = new Store(dir);
  try {
    const owner = resolveLocalOwner(store);
    const a = createUser(store, { displayName: "A", role: "trusted" });
    const b = createUser(store, { displayName: "B", role: "standard" });
    const first = persistVerifiedLesson(
      store,
      lessonFromCodingSuccess({
        summary: "Always retest after apply_patch",
        testEvidence: "tests passed exit 0",
        userId: a.id,
      }),
    );
    assert.equal(first.saved, true);
    persistVerifiedLesson(
      store,
      lessonFromCodingSuccess({
        summary: "Always retest after apply_patch",
        testEvidence: "tests passed exit 0",
        userId: a.id,
      }),
    );
    const forB = store.relevantMemories("retest apply_patch", { userId: b.id });
    assert.ok(!forB.some((m) => m.content.includes("Always retest")));
    const forA = store.relevantMemories("retest apply_patch", { userId: a.id });
    assert.ok(forA.some((m) => /lesson:coding/.test(m.content)));
    void owner;
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("per-user council and remote prefs stay isolated", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-prefs-"));
  const store = new Store(dir);
  try {
    resolveLocalOwner(store);
    const a = createUser(store, { displayName: "A", role: "owner" });
    const b = createUser(store, { displayName: "B", role: "standard" });
    savePreferences(
      store,
      {
        ...DEFAULT_PREFERENCES,
        councilMode: "on",
        remoteAi: "allowed",
      },
      a.id,
    );
    savePreferences(
      store,
      {
        ...DEFAULT_PREFERENCES,
        councilMode: "off",
        remoteAi: "never",
      },
      b.id,
    );
    assert.equal(getPreferences(store, a.id).councilMode, "on");
    assert.equal(getPreferences(store, a.id).remoteAi, "allowed");
    assert.equal(getPreferences(store, b.id).councilMode, "off");
    assert.equal(getPreferences(store, b.id).remoteAi, "never");
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("privacy sanitizer redacts secrets before remote prompts", () => {
  const { text, sensitive, redacted } = sanitizeForRemote(
    "use key sk-abcdefghijklmnopqrstuvwxyz password: secret123",
  );
  assert.ok(sensitive);
  assert.ok(redacted >= 1);
  assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!text.includes("secret123"));
});
