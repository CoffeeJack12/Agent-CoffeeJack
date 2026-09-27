/**
 * Fast-path greeting latency + chat visibility regressions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "../server/index.mjs";
import { resolveTurnContext } from "../server/conversation-intent.mjs";
import { routeModel } from "../server/router.mjs";
import { shouldConsultCouncil } from "../server/council.mjs";
import { createTurnTiming } from "../server/latency.mjs";
import { Ollama, buildChatRequest } from "../server/ollama.mjs";

const visibilityUrl = pathToFileURL(
  path.join(process.cwd(), "public", "chat-visibility.js"),
).href;
const {
  shouldShowCouncilInChat,
  shouldShowToolInChat,
  shouldShowMessageDetails,
} = await import(visibilityUrl);

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-fast-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

test("hey uses fast path: 8b, no council/tools/research/memory/verification", () => {
  const turn = resolveTurnContext("hey", { history: [] });
  assert.equal(turn.fastPath, true);
  assert.equal(turn.intent, "greeting");
  assert.equal(turn.instantGreeting, true);
  assert.equal(turn.allowResearch, false);
  assert.equal(turn.allowVerification, false);
  assert.equal(turn.allowMemoryWrite, false);
  assert.equal(turn.allowWebSearch, false);
  assert.equal(
    shouldConsultCouncil({
      text: "hey",
      availableModels: [
        { id: "qwen3:8b", provider: "ollama", local: true },
        { id: "qwen3:14b", provider: "ollama", local: true },
        { id: "other:7b", provider: "ollama", local: true },
      ],
      preferences: { councilMode: "auto" },
      taskKind: "general",
    }).consult,
    false,
  );
});

test("trivial greetings stay on fast path", () => {
  for (const text of [
    "hi",
    "hello",
    "hey jack",
    "thanks",
    "ok",
    "yea",
    "good morning",
    "how are you",
    "هلا",
    "هاي",
    "السلام عليكم",
  ]) {
    assert.equal(resolveTurnContext(text, { history: [] }).fastPath, true, text);
  }
});

test("chat UI hides council_off and routine tool success", () => {
  assert.equal(
    shouldShowCouncilInChat({
      type: "council",
      status: "skipped",
      detail: "council_off",
      title: "AI Council",
    }),
    false,
  );
  assert.equal(
    shouldShowCouncilInChat({
      type: "council",
      status: "skipped",
      detail: "not_warranted",
    }),
    false,
  );
  assert.equal(
    shouldShowToolInChat({
      type: "tool",
      name: "recall",
      status: "done",
      result: { ok: true },
    }),
    false,
  );
  assert.equal(
    shouldShowToolInChat({
      type: "tool",
      name: "search_code",
      status: "done",
      result: { matches: [] },
    }),
    false,
  );
  assert.equal(
    shouldShowToolInChat({
      type: "tool",
      name: "inspect_pc",
      status: "done",
      result: { ok: true },
    }),
    false,
  );
  assert.equal(
    shouldShowToolInChat({
      type: "tool",
      name: "web_search",
      status: "done",
      result: { results: [] },
    }),
    false,
  );
  assert.equal(
    shouldShowMessageDetails([
      { type: "council", status: "skipped", detail: "council_off" },
      { type: "tool", name: "recall", status: "done", result: {} },
    ]),
    false,
  );
});

test("actionable approval/research/error cards remain visible", () => {
  assert.equal(
    shouldShowToolInChat({
      type: "tool",
      name: "research",
      status: "done",
      result: { sources: [{ title: "A", url: "https://a.test" }] },
    }),
    true,
  );
  assert.equal(
    shouldShowToolInChat({
      type: "tool",
      name: "terminal",
      status: "error",
      result: { error: "denied" },
    }),
    true,
  );
  assert.equal(
    shouldShowCouncilInChat({
      type: "council",
      status: "done",
      title: "AI Council",
      proposals: [
        { role: "critic", provider: "ollama", model: "qwen3:14b", status: "ok" },
      ],
    }),
    true,
  );
  assert.equal(
    shouldShowMessageDetails([
      { type: "approval", id: "1", name: "terminal" },
      { type: "self_repair", proposal: { id: "p1" } },
    ]),
    true,
  );
});

test("fastPath routeModel skips registry.refresh and inspect", async () => {
  let refreshCount = 0;
  let inspectCount = 0;
  const ollama = {
    models: async () => [{ name: "qwen3:8b" }, { name: "qwen3:14b" }],
    inspect: async () => {
      inspectCount++;
      return { capabilities: ["tools"], model_info: { "general.architecture": "qwen3" } };
    },
  };
  const registry = {
    refresh: async () => {
      refreshCount++;
    },
    listModels: () => [
      {
        id: "qwen3:8b",
        provider: "ollama",
        local: true,
        capabilities: ["tools"],
      },
      {
        id: "qwen3:14b",
        provider: "ollama",
        local: true,
        capabilities: ["tools"],
      },
    ],
  };
  const route = await routeModel({
    ollama,
    registry,
    settings: { model: "auto" },
    text: "hey",
    requestedModel: "auto",
    preferences: { remoteAi: "never" },
    fastPath: true,
  });
  assert.equal(route.model, "qwen3:8b");
  assert.equal(route.fastPath, true);
  assert.equal(refreshCount, 0);
  assert.equal(inspectCount, 0);
  assert.match(String(route.profile?.keepAlive || "10m"), /10m/);
});

test("hey chat stream: instant greeting, no Ollama/council/tools", async (t) => {
  const dir = await temporary(t);
  let chatCalls = 0;
  let prepareCalls = 0;
  let modelsCalls = 0;
  let inspectCalls = 0;
  const fake = {
    models: async () => {
      modelsCalls++;
      return [{ name: "qwen3:8b" }, { name: "qwen3:14b" }];
    },
    inspect: async () => {
      inspectCalls++;
      return { capabilities: ["tools"] };
    },
    prepare: async () => {
      prepareCalls++;
      return { alreadyLoaded: true, unloaded: [] };
    },
    unload: async () => [],
    chat: async () => {
      chatCalls++;
      throw new Error("Ollama must not run for a pure greeting");
    },
  };
  const app = await createApp({ dataDirectory: dir, ollama: fake });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(base + "/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": app.token,
    },
    body: JSON.stringify({ text: "hey", requestedModel: "auto" }),
  });
  assert.equal(response.status, 200);
  const events = (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const reply = events
    .filter((e) => e.type === "token")
    .map((e) => e.text)
    .join("");
  assert.equal(reply, "At your service, Master.");
  assert.equal(chatCalls, 0);
  assert.equal(prepareCalls, 0);
  assert.equal(modelsCalls, 0);
  assert.equal(inspectCalls, 0);
  assert.ok(events.some((e) => e.type === "done"));
  assert.ok(events.some((e) => e.type === "turn_context" && e.instantGreeting === true));
  assert.equal(
    events.some((e) => e.type === "routing"),
    false,
  );
  assert.equal(
    events.some((e) => e.type === "council"),
    false,
    "no council events on instant greeting",
  );
  assert.equal(events.some((e) => e.type === "tool"), false);
  assert.equal(events.some((e) => e.type === "self_repair"), false);
  const activity = await (
    await fetch(base + "/api/events", {
      headers: { "X-CoffeeJack-Token": app.token },
    })
  ).json();
  assert.ok(Array.isArray(activity));
});

test("activity log still records tool events when tools run", async (t) => {
  const dir = await temporary(t);
  let round = 0;
  const fake = {
    models: async () => [{ name: "qwen3:14b" }],
    inspect: async () => ({ capabilities: ["tools"] }),
    prepare: async () => ({ alreadyLoaded: true, unloaded: [] }),
    unload: async () => [],
    chat: async () => {
      if (round++ === 0) {
        return {
          role: "assistant",
          content: "",
          tokens: 0,
          tool_calls: [
            {
              function: {
                name: "search_code",
                arguments: { query: "foo" },
              },
            },
          ],
        };
      }
      return { role: "assistant", content: "Found nothing.", tokens: 2 };
    },
  };
  const app = await createApp({ dataDirectory: dir, ollama: fake });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  // Non-greeting so tools are offered.
  const response = await fetch(base + "/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": app.token,
    },
    body: JSON.stringify({
      text: "search the codebase for foo helper",
      requestedModel: "qwen3:14b",
    }),
  });
  const text = await response.text();
  const events = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(events.some((e) => e.type === "tool" && e.name === "search_code"));
  // Chat visibility policy would hide this routine success.
  const toolDone = events.find(
    (e) => e.type === "tool" && e.name === "search_code" && e.status === "done",
  );
  assert.equal(shouldShowToolInChat(toolDone), false);
  const activity = await (
    await fetch(base + "/api/events", {
      headers: { "X-CoffeeJack-Token": app.token },
    })
  ).json();
  assert.ok(
    activity.some((e) => e.tool === "search_code" && e.status === "done"),
    "Activity log must still record the tool",
  );
});

test("latency snapshot exposes required stage fields", () => {
  const timing = createTurnTiming();
  timing.mark("context_resolved");
  timing.mark("routing_done");
  timing.mark("memory_start");
  timing.mark("memory_done");
  timing.mark("council_start");
  timing.mark("council_done");
  timing.mark("prepare_start");
  timing.setFlag("model_already_loaded", true);
  timing.mark("model_ready");
  timing.mark("ollama_request_sent");
  timing.mark("first_token");
  timing.mark("guard_start");
  timing.mark("guard_done");
  const snap = timing.snapshot();
  for (const key of [
    "request_received_ms",
    "context_resolution_ms",
    "routing_ms",
    "memory_ms",
    "council_ms",
    "model_prepare_ms",
    "ollama_request_ms",
    "first_ollama_token_ms",
    "first_ui_token_ms",
    "guard_ms",
    "total_ms",
  ]) {
    assert.ok(key in snap, key);
  }
  assert.equal(snap.model_already_loaded, true);
});

test("ollama soft prepare skips unload when model already resident", async () => {
  const calls = [];
  const ollama = new Ollama("http://127.0.0.1:11434");
  ollama.request = async (endpoint, body) => {
    calls.push({ endpoint, body });
    if (endpoint === "/api/ps") {
      return {
        ok: true,
        json: async () => ({
          models: [{ name: "qwen3:8b" }, { name: "qwen3:14b" }],
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };
  const soft = await ollama.prepare("qwen3:8b", undefined, { soft: true });
  assert.equal(soft.alreadyLoaded, true);
  assert.deepEqual(soft.unloaded, []);
  assert.equal(
    calls.some((c) => c.endpoint === "/api/generate"),
    false,
    "soft prepare must not unload siblings when target is warm",
  );
  const hard = await ollama.prepare("qwen3:8b", undefined, { soft: false });
  assert.equal(hard.alreadyLoaded, true);
  assert.ok(hard.unloaded.includes("qwen3:14b"));
});

test("keep_alive for general 8b remains 10m", () => {
  const body = buildChatRequest({
    model: "qwen3:8b",
    messages: [{ role: "user", content: "hey" }],
    profile: { keepAlive: "10m", context: 4096, predict: 512 },
  });
  assert.equal(body.keep_alive, "10m");
  assert.equal(body.stream, true);
});
