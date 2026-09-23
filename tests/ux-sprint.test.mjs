import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import {
  getPreferences,
  savePreferences,
  preferencePrompt,
  DEFAULT_PREFERENCES,
  MODES,
  APP_LANGUAGES,
  ASSISTANT_LANGUAGES,
} from "../server/preferences.mjs";
import {
  resolveEffectiveMode,
  modelTaskKind,
} from "../server/auto-mode.mjs";
import {
  extractMemories,
  applyAutomaticMemory,
  memoryCategory,
} from "../server/auto-memory.mjs";
import { routeModel, classifyTask } from "../server/router.mjs";
import { toolFeedback } from "../server/agent.mjs";
import { buildCapabilityRegistry } from "../server/capabilities.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-sprint-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, store };
}

test("Jarvis mode migrates to Auto and is removed from catalog", async (t) => {
  const { store } = await fixture(t);
  store.saveProfilePreferences("owner", {
    ...DEFAULT_PREFERENCES,
    mode: "jarvis",
  });
  const prefs = getPreferences(store);
  assert.equal(prefs.mode, "auto");
  assert.ok(!Object.hasOwn(MODES, "jarvis"));
  assert.deepEqual(Object.keys(MODES), [
    "auto",
    "hacker",
    "developer",
    "research",
    "empathy",
    "secret_agent",
  ]);
  assert.equal(getPreferences(store).mode, "auto");
});

test("Auto mode switches effectiveMode per turn; manual override stays locked", () => {
  const empathy = resolveEffectiveMode({
    requestedMode: "auto",
    text: "today was exhausting",
  });
  assert.equal(empathy.effectiveMode, "empathy");
  assert.equal(empathy.requestedMode, "auto");

  const hacker = resolveEffectiveMode({
    requestedMode: "auto",
    text: "inspect my network",
  });
  assert.equal(hacker.effectiveMode, "hacker");

  const research = resolveEffectiveMode({
    requestedMode: "auto",
    text: "what is the latest Ollama release?",
  });
  assert.equal(research.effectiveMode, "research");

  const developer = resolveEffectiveMode({
    requestedMode: "auto",
    text: "fix this Node project and run tests",
  });
  assert.equal(developer.effectiveMode, "developer");

  const hybrid = resolveEffectiveMode({
    requestedMode: "auto",
    text: "search GitHub for the cause of this bug and patch my project",
  });
  assert.ok(hybrid.hybrid.includes("research"));
  assert.ok(hybrid.hybrid.includes("developer"));

  const locked = resolveEffectiveMode({
    requestedMode: "hacker",
    text: "this bug is making me insane and I feel exhausted",
  });
  assert.equal(locked.effectiveMode, "hacker");
  assert.equal(locked.reason, "manual override");
});

test("App language and assistant language catalogs stay separate", () => {
  assert.deepEqual(Object.keys(APP_LANGUAGES), ["auto", "en", "ar"]);
  assert.deepEqual(Object.keys(ASSISTANT_LANGUAGES), [
    "auto",
    "en",
    "ar",
    "mixed",
  ]);
  assert.ok(DEFAULT_PREFERENCES.appLanguage);
  assert.ok(DEFAULT_PREFERENCES.language);
  assert.notEqual(
    JSON.stringify(APP_LANGUAGES),
    JSON.stringify(ASSISTANT_LANGUAGES),
  );
});

test("Auto model selects installed model; manual lock wins", async () => {
  const ollama = {
    models: async () => [{ name: "qwen3:8b" }],
    inspect: async () => ({ capabilities: ["tools"] }),
  };
  const settings = { model: "qwen3:8b", codingModel: "qwen3:8b" };
  const auto = await routeModel({
    ollama,
    settings,
    text: "hello",
    requestedModel: "auto",
  });
  assert.equal(auto.requestedModel, "auto");
  assert.equal(auto.effectiveModel, "qwen3:8b");
  assert.equal(auto.model, "qwen3:8b");

  const locked = await routeModel({
    ollama,
    settings,
    text: "debug code",
    requestedModel: "qwen3:8b",
    effectiveMode: "developer",
  });
  assert.equal(locked.requestedModel, "qwen3:8b");
  assert.equal(locked.reason, "Manual model lock");

  assert.equal(classifyTask({ text: "debug this code" }), "coding");
  assert.equal(
    modelTaskKind({ effectiveMode: "developer", text: "hi" }),
    "coding",
  );
});

test("unavailable model falls back to installed local model", async () => {
  const ollama = {
    models: async () => [{ name: "qwen3:8b" }],
    inspect: async () => ({ capabilities: ["tools"] }),
  };
  const route = await routeModel({
    ollama,
    settings: { model: "missing", codingModel: "also-missing" },
    text: "hello",
    requestedModel: "gone",
  });
  assert.equal(route.model, "qwen3:8b");
  assert.equal(route.fallback, true);
});

test("CapabilityRegistry still powers Auto routing prefs", () => {
  const registry = buildCapabilityRegistry({
    preferences: { ...DEFAULT_PREFERENCES, mode: "auto" },
    gaming: false,
    modelCapabilities: ["tools"],
    platform: "win32",
  });
  assert.ok(registry.find((c) => c.id === "terminal").enabled);
  assert.ok(registry.find((c) => c.id === "research").enabled);
  const gaming = buildCapabilityRegistry({
    preferences: { ...DEFAULT_PREFERENCES, mode: "auto" },
    gaming: true,
    platform: "win32",
  });
  assert.equal(gaming.find((c) => c.id === "terminal").enabled, false);
});

test("automatic memory extracts preferences, dedupes, rejects secrets, respects Off", async (t) => {
  const { store } = await fixture(t);
  const extracted = extractMemories(
    "From now on call me Lord and keep answers concise. I use Windows.",
  );
  assert.ok(extracted.some((m) => m.setting?.address === "lord"));
  assert.ok(extracted.some((m) => m.setting?.verbosity === "concise"));
  assert.ok(extracted.some((m) => /Windows/i.test(m.content)));
  assert.equal(extractMemories("password: hunter2").length, 0);

  const first = applyAutomaticMemory(
    store,
    "Call me Lord and keep answers concise.",
    { behavior: "auto", preferences: getPreferences(store) },
  );
  assert.ok(first.saved.length >= 1);
  assert.equal(first.preferences.address, "lord");
  assert.equal(first.preferences.verbosity, "concise");

  const second = applyAutomaticMemory(
    store,
    "Keep it short please.",
    { behavior: "auto", preferences: first.preferences },
  );
  const prefs = store.memories().filter((m) => m.kind === "preference");
  assert.ok(prefs.length <= 3);

  const off = applyAutomaticMemory(store, "Call me Sir", {
    behavior: "off",
    preferences: getPreferences(store),
  });
  assert.equal(off.saved.length, 0);

  const ask = applyAutomaticMemory(store, "I use Windows", {
    behavior: "ask",
    preferences: getPreferences(store),
  });
  assert.ok(ask.pending.length >= 1);
  assert.equal(ask.saved.length, 0);

  assert.equal(memoryCategory("preference", "Address preference: Lord"), "Preferences");
  assert.equal(memoryCategory("note", "Uses Windows"), "Environment");
  assert.equal(memoryCategory("note", "Project: CoffeeJack"), "Projects");
});

test("cross-chat memory and settings sync for address/verbosity", async (t) => {
  const { store } = await fixture(t);
  applyAutomaticMemory(
    store,
    "From now on call me Lord and keep your answers concise.",
    { chatId: "chat-a", behavior: "auto", preferences: getPreferences(store) },
  );
  const prefs = getPreferences(store);
  assert.equal(prefs.address, "lord");
  assert.equal(prefs.verbosity, "concise");
  const prompt = preferencePrompt(prefs);
  assert.match(prompt, /Lord/);
  assert.match(prompt, /verbosity: concise/);
  assert.ok(store.memories().length >= 1);
});

test("app language preference can be learned from clear UI requests", async (t) => {
  const { store } = await fixture(t);
  const result = applyAutomaticMemory(
    store,
    "I want CoffeeJack itself in English.",
    { behavior: "auto", preferences: getPreferences(store) },
  );
  assert.equal(result.preferences.appLanguage, "en");
});

test("research tool feedback attributes tool output, not the user", () => {
  const feedback = toolFeedback(
    {
      query: "ollama release",
      sources: [
        {
          title: "Ollama",
          url: "https://example.com",
          content: "<html>giant</html> " + "x".repeat(5000),
        },
      ],
    },
    "research",
  );
  const parsed = JSON.parse(feedback);
  assert.match(parsed._attribution, /not user-authored|own tool output/i);
  assert.ok(!/you've provided|user pasted/i.test(feedback));
  assert.ok(parsed.sources[0].excerpt.length <= 600);
  assert.match(preferencePrompt(DEFAULT_PREFERENCES), /role=tool/);
  assert.match(
    preferencePrompt(DEFAULT_PREFERENCES),
    /never user-authored|YOUR tool output/i,
  );
});

test("mode descriptions are workflow profiles in preferences prompt", () => {
  for (const id of Object.keys(MODES)) {
    assert.ok(MODES[id].description.length > 20);
    const text = preferencePrompt({ ...DEFAULT_PREFERENCES, mode: id });
    assert.match(text, new RegExp(MODES[id].label));
  }
});

test("default mode persists separately from ephemeral current-mode concept", async (t) => {
  const { store } = await fixture(t);
  savePreferences(store, { mode: "developer" });
  assert.equal(getPreferences(store).mode, "developer");
  const turn = resolveEffectiveMode({
    requestedMode: "hacker",
    text: "hello",
  });
  assert.equal(turn.effectiveMode, "hacker");
  assert.equal(getPreferences(store).mode, "developer");
});
