import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { runAgent } from "../server/agent.mjs";
import { savePreferences, DEFAULT_PREFERENCES } from "../server/preferences.mjs";
import {
  buildCapabilityRegistry,
  capabilityPrompt,
  capabilitySummary,
  isCapabilityQuestion,
  scrubStoredCapabilityClaims,
  scrubBoilerplateText,
} from "../server/capabilities.mjs";
import { guardResponse } from "../server/task-state.mjs";
import { advanceTask } from "../server/task-state.mjs";

const fullPrefs = { ...DEFAULT_PREFERENCES, mode: "jarvis", capabilities: null };

test("CapabilityRegistry reflects enabled packs, platform and gaming", () => {
  const registry = buildCapabilityRegistry({
    preferences: fullPrefs,
    gaming: false,
    modelCapabilities: ["tools"],
    platform: "win32",
  });
  const byId = Object.fromEntries(registry.map((c) => [c.id, c]));
  assert.equal(byId.terminal.enabled, true);
  assert.equal(byId.files.enabled, true);
  assert.equal(byId.browser.enabled, true);
  assert.equal(byId.research.enabled, true);
  assert.equal(byId.inspect_pc.enabled, true);
  assert.equal(byId.desktop.enabled, true);
  assert.equal(byId.git.enabled, true);
  assert.equal(byId.developer.enabled, true);
  assert.equal(byId.voice.available, false);
  assert.equal(byId.vision.enabled, false);
  const summary = capabilitySummary(registry);
  assert.match(summary, /Terminal: enabled/);
  assert.match(summary, /Vision: unavailable/);
  assert.match(summary, /Voice: unavailable/);
  const gaming = buildCapabilityRegistry({
    preferences: fullPrefs,
    gaming: true,
    platform: "win32",
  });
  assert.equal(gaming.find((c) => c.id === "terminal").enabled, false);
  assert.equal(gaming.find((c) => c.id === "memory").enabled, true);
});

test("capability questions are distinguished from action requests", () => {
  assert.equal(isCapabilityQuestion("can u control my PC?"), true);
  assert.equal(isCapabilityQuestion("can you search the web?"), true);
  assert.equal(isCapabilityQuestion("what can you do?"), true);
  assert.equal(isCapabilityQuestion("inspect my PC"), false);
  assert.equal(isCapabilityQuestion("search the latest Ollama release"), false);
  assert.equal(isCapabilityQuestion("check my network"), false);
});

test("capability prompt forbids false PC-control denials when tools are enabled", () => {
  const registry = buildCapabilityRegistry({
    preferences: fullPrefs,
    platform: "win32",
  });
  const prompt = capabilityPrompt(registry, {
    text: "can u control my PC?",
    preferences: fullPrefs,
  });
  assert.match(prompt, /AVAILABLE NOW/);
  assert.match(prompt, /You CAN control this PC/);
  assert.match(prompt, /Do NOT launch tools/);
  assert.match(prompt, /Depends on the target/);
});

test("tone guard strips false PC denial and cyber boilerplate when PC tools are enabled", () => {
  const registry = buildCapabilityRegistry({
    preferences: fullPrefs,
    platform: "win32",
  });
  const state = advanceTask(null, "can u control my PC?", { project: "/tmp" });
  const denied = guardResponse(
    state,
    "I cannot control your PC directly. As an AI I cannot interact with your computer.",
    "can u control my PC?",
    { registry },
  );
  assert.doesNotMatch(denied.text, /cannot control your PC|as an AI|I cannot directly/i);
  assert.match(denied.text, /connected tools|PowerShell|objective/i);

  const cyber = guardResponse(
    state,
    "I cannot hack or bypass security systems. My purpose is to assist and support you in a lawful and ethical manner.",
    "can u hack something or bypass some security system?",
    { registry },
  );
  assert.doesNotMatch(
    cyber.text,
    /lawful and ethical|my purpose is|I cannot hack or bypass|legality and ethics/i,
  );
  assert.match(cyber.text, /target|objective|access|modify|test|bypass/i);
});

test("stored instruction boilerplate is scrubbed for existing installs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-scrub-"));
  const store = new Store(dir);
  try {
    store.set(
      "instructions",
      "Be helpful. My purpose is to assist within lawful and ethical boundaries. I cannot control your PC.",
    );
    const result = scrubStoredCapabilityClaims(store);
    assert.equal(result.cleaned, true);
    assert.doesNotMatch(
      store.get("instructions"),
      /lawful and ethical|my purpose is|cannot control your PC/i,
    );
    assert.match(scrubBoilerplateText("As an AI language model, I cannot help"), /help/);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function chatFixture(t, prefs, answers, text) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-cap-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  savePreferences(store, prefs);
  const chatId = store.createChat("capability").id;
  let n = 0;
  let output = "";
  const tools = [];
  let executed = 0;
  const prompts = [];
  await runAgent({
    store,
    chatId,
    text,
    model: "test",
    capabilities: ["tools"],
    signal: new AbortController().signal,
    emit: (e) => {
      if (e.type === "token") output += e.text;
      if (e.type === "tool") tools.push(`${e.name}:${e.status}`);
    },
    tools: {
      workspace: dir,
      execute: async (name, args) => {
        executed++;
        if (name === "inspect_pc")
          return { code: 0, output: JSON.stringify({ Interface: "Ethernet", IPv4: "10.0.0.2" }) };
        if (name === "research")
          return {
            query: args.query,
            sources: [{ url: "https://example.com/ollama", title: "Ollama", content: "v9", untrusted: true }],
            untrusted: true,
          };
        return { code: 0 };
      },
    },
    ollama: {
      chat: async (request) => {
        prompts.push(structuredClone(request.messages));
        const answer = answers[Math.min(n++, answers.length - 1)];
        if (answer.content) request.onToken?.(answer.content);
        return structuredClone({ role: "assistant", ...answer, tokens: 1 });
      },
    },
  });
  return { store, chatId, output, tools, executed, prompts, n };
}

test('can u control my PC? affirms live capabilities and does not deny control', async (t) => {
  const f = await chatFixture(
    t,
    { mode: "jarvis" },
    [
      {
        content:
          "I cannot control your PC directly. As an AI I cannot interact with your computer.",
      },
    ],
    "can u control my PC?",
  );
  assert.match(f.prompts[0][0].content, /AVAILABLE NOW/);
  assert.match(f.prompts[0][0].content, /Terminal: enabled/);
  assert.equal(f.executed, 0);
  assert.doesNotMatch(
    f.output,
    /cannot control your PC|I cannot directly|as an AI/i,
  );
  assert.match(f.output, /PowerShell|connected tools|objective|approval/i);
});

test("inspect my PC executes inspect_pc instead of instructions", async (t) => {
  const f = await chatFixture(
    t,
    { mode: "hacker" },
    [
      {
        content: "",
        tool_calls: [
          { function: { name: "inspect_pc", arguments: { section: "network" } } },
        ],
      },
      {
        content:
          "Ethernet is up at 10.0.0.2 according to inspect_pc.",
      },
    ],
    "inspect my PC",
  );
  assert.ok(f.executed >= 1);
  assert.ok(f.tools.some((t) => t.startsWith("inspect_pc:")));
  assert.match(f.output, /10\.0\.0\.2|Ethernet/);
  assert.doesNotMatch(f.output, /run this PowerShell|you can open Settings/i);
});

test("can u search the web? confirms research without executing", async (t) => {
  const f = await chatFixture(
    t,
    { mode: "research" },
    [
      {
        content:
          "Yes. I can search the web, open multiple sources, compare them and give you a sourced answer. What are we looking for?",
      },
    ],
    "can u search the web?",
  );
  assert.equal(f.executed, 0);
  assert.match(f.prompts[0][0].content, /Web research: enabled|Web search: enabled/);
  assert.match(f.output, /search the web|sources|sourced/i);
});

test("search the latest Ollama release executes research", async (t) => {
  const f = await chatFixture(
    t,
    { mode: "research" },
    [
      {
        content: "",
        tool_calls: [
          {
            function: {
              name: "research",
              arguments: { query: "latest Ollama release" },
            },
          },
        ],
      },
      {
        content:
          "Latest notes from https://example.com/ollama — v9 is important.",
      },
    ],
    "search the latest Ollama release",
  );
  assert.ok(f.executed >= 1);
  assert.ok(f.tools.some((t) => t.startsWith("research:")));
  assert.match(f.output, /example\.com\/ollama|v9/);
});

test("hack/bypass capability question asks for target without legal boilerplate", async (t) => {
  const f = await chatFixture(
    t,
    { mode: "hacker" },
    [
      {
        content:
          "I cannot hack or bypass security systems. My purpose is to assist and support you in a lawful and ethical manner within the boundaries of legality and ethics.",
      },
    ],
    "can u hack something or bypass some security system?",
  );
  assert.doesNotMatch(
    f.output,
    /lawful and ethical|legality and ethics|my purpose is|I cannot hack or bypass security systems/i,
  );
  assert.match(f.output, /target|objective|access|modify|test|bypass/i);
  assert.equal(f.executed, 0);
});

test("Steam local-game context is retained when asking if Jack can inspect", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-steam-cap-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  savePreferences(store, { mode: "hacker" });
  const chatId = store.createChat("steam").id;
  const replies = [
    "Where is the game running?",
    "Got it — local Steam game. Which title?",
    "Yes. I can inspect the local Steam install with files, terminal and desktop tools once I know the game name.",
  ];
  let n = 0;
  const answers = [];
  for (const text of [
    "I wanna inspect a game",
    "a game on my device",
    "from Steam",
  ]) {
    let output = "";
    await runAgent({
      store,
      chatId,
      text,
      model: "test",
      capabilities: ["tools"],
      signal: new AbortController().signal,
      emit: (e) => {
        if (e.type === "token") output += e.text;
      },
      tools: { workspace: dir, execute: async () => ({ code: 0 }) },
      ollama: {
        chat: async ({ onToken }) => {
          const content = replies[n++];
          onToken?.(content);
          return { role: "assistant", content, tokens: 1 };
        },
      },
    });
    answers.push(output);
  }
  const state = store.taskState(chatId);
  assert.ok(state.facts.targetLocation || state.facts.distribution);
  assert.doesNotMatch(
    answers[2],
    /your machine, a lab\/CTF, or an external system/i,
  );
  let inspectOut = "";
  await runAgent({
    store,
    chatId,
    text: "can you inspect it?",
    model: "test",
    capabilities: ["tools"],
    signal: new AbortController().signal,
    emit: (e) => {
      if (e.type === "token") inspectOut += e.text;
    },
    tools: { workspace: dir, execute: async () => ({ code: 0 }) },
    ollama: {
      chat: async ({ messages, onToken }) => {
        assert.match(messages[0].content, /AVAILABLE NOW|Steam|device|local/i);
        const content =
          "Yes — local Steam context is saved. Name the game and I will inspect it.";
        onToken?.(content);
        return { role: "assistant", content, tokens: 1 };
      },
    },
  });
  assert.doesNotMatch(
    inspectOut,
    /your machine, a lab\/CTF, or an external system/i,
  );
  assert.match(inspectOut, /Steam|inspect|local/i);
});
