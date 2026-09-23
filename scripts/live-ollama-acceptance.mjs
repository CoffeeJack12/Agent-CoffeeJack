/**
 * Real Ollama acceptance (qwen3:8b) — not mocks.
 * Run: node scripts/live-ollama-acceptance.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { savePreferences, getPreferences } from "../server/preferences.mjs";
import { resolveEffectiveMode } from "../server/auto-mode.mjs";
import { extractMemories } from "../server/auto-memory.mjs";
import { buildCapabilityRegistry } from "../server/capabilities.mjs";
import { DEFAULT_PREFERENCES } from "../server/preferences.mjs";

const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

async function requireQwen() {
  const res = await fetch(`${OLLAMA}/api/tags`);
  if (!res.ok) throw new Error("Ollama not reachable at " + OLLAMA);
  const data = await res.json();
  const names = (data.models || []).map((m) => m.name);
  assert.ok(
    names.some((n) => n === "qwen3:8b" || n.startsWith("qwen3:8b")),
    "qwen3:8b must be installed, found: " + names.join(", "),
  );
  return names;
}

async function streamChat(port, token, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": token,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "chat failed " + response.status);
  }
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
  }
  return events;
}

function transcript(events) {
  return events
    .filter((e) => e.type === "token")
    .map((e) => e.text)
    .join("");
}

async function makeBuggyProject(root) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "coffeejack-live-acceptance-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test test.mjs" },
      },
      null,
      2,
    ),
  );
  // Bug: add returns a*b instead of a+b
  await fs.writeFile(
    path.join(root, "math.mjs"),
    "export function add(a, b) {\n  return a * b;\n}\n",
  );
  await fs.writeFile(
    path.join(root, "test.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { add } from "./math.mjs";
test("add sums two numbers", () => {
  assert.equal(add(2, 3), 5);
});
`,
  );
}

const results = [];
const pass = (name, detail = "") => {
  results.push({ name, ok: true, detail });
  console.log("PASS", name, detail);
};
const fail = (name, error) => {
  results.push({ name, ok: false, detail: String(error) });
  console.error("FAIL", name, error);
};

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-live-ollama-"));
const fixtureDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "jack-live-fixture-"),
);
await makeBuggyProject(fixtureDir);

try {
  await requireQwen();
  pass("Ollama qwen3:8b available");

  const app = await createApp({ dataDirectory: dataDir });
  app.store.set("autoGaming", false);
  app.store.set("model", "qwen3:8b");
  app.store.set("autoApprove", true);
  savePreferences(app.store, {
    mode: "auto",
    model: "auto",
    memoryBehavior: "off",
    language: "en",
    appLanguage: "en",
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = app.server.address().port;
  const token = app.token;

  // CapabilityRegistry sanity
  const registry = buildCapabilityRegistry({
    preferences: { ...DEFAULT_PREFERENCES, mode: "auto" },
    gaming: false,
    modelCapabilities: ["tools", "thinking"],
    platform: "win32",
  });
  assert.ok(registry.find((c) => c.id === "research").enabled);
  assert.ok(registry.find((c) => c.id === "terminal").enabled);
  pass("CapabilityRegistry research+terminal enabled");

  // Ephemeral noise must not become memories
  assert.equal(
    extractMemories(
      "acceptance-test temporary fixture: call me Lord on this machine",
    ).length,
    0,
  );
  pass("Memory skips acceptance-test noise");

  // A — AUTO RESEARCH
  try {
    const mode = resolveEffectiveMode({
      requestedMode: "auto",
      text: "what is the latest Ollama release and what changed?",
    });
    assert.ok(
      mode.effectiveMode === "research" || mode.hybrid.includes("research"),
      "expected research routing, got " + JSON.stringify(mode),
    );
    const events = await streamChat(port, token, {
      text: "what is the latest Ollama release and what changed?",
      requestedMode: "auto",
      requestedModel: "auto",
      mode: "auto",
    });
    const routing = events.find((e) => e.type === "routing");
    assert.ok(routing, "missing routing event");
    assert.match(routing.model, /qwen3:8b/);
    assert.equal(routing.requestedModel, "auto");
    assert.ok(
      routing.effectiveMode === "research" ||
        mode.effectiveMode === "research",
    );
    const researchTools = events.filter(
      (e) => e.type === "tool" && e.name === "research",
    );
    assert.ok(researchTools.some((e) => e.status === "running"));
    assert.ok(researchTools.some((e) => e.status === "done"));
    const reply = transcript(events);
    assert.ok(reply.length > 40, "empty research reply");
    assert.doesNotMatch(
      reply,
      /you(?:'ve| have) provided|user (?:pasted|supplied)|large block of text/i,
    );
    assert.ok(
      reply.length < 12000,
      "reply looks like a giant dump (" + reply.length + ")",
    );
    assert.match(reply, /https?:\/\//i);
    pass(
      "A AUTO RESEARCH",
      `model=${routing.model} tools=${researchTools.length} chars=${reply.length}`,
    );
    console.log("--- research reply preview ---\n" + reply.slice(0, 900) + "\n---");
  } catch (error) {
    fail("A AUTO RESEARCH", error.message || error);
  }

  // B — AUTO DEVELOPER on isolated fixture (not CoffeeJack)
  try {
    const settingsRes = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CoffeeJack-Token": token,
      },
      body: JSON.stringify({
        workspace: fixtureDir,
        autoApprove: true,
        model: "qwen3:8b",
      }),
    });
    assert.equal(settingsRes.status, 200);
    const before = await fs.readFile(path.join(fixtureDir, "math.mjs"), "utf8");
    assert.match(before, /a \* b/);

    const events = await streamChat(port, token, {
      text:
        "This is an isolated temporary Node test project for live acceptance only. " +
        "Inspect math.mjs, identify the bug in add(), patch it so tests pass, run tests, " +
        "inspect git status/diff if available, and report only verified success.",
      requestedMode: "auto",
      requestedModel: "auto",
      mode: "auto",
    });
    const routing = events.find((e) => e.type === "routing");
    assert.match(routing?.model || "", /qwen3:8b/);
    const toolsUsed = [
      ...new Set(
        events.filter((e) => e.type === "tool").map((e) => e.name),
      ),
    ];
    assert.ok(
      toolsUsed.some((n) =>
        /read_file|search_code|apply_patch|write_file|run_tests|terminal|git_/.test(
          n,
        ),
      ),
      "no developer tools used: " + toolsUsed.join(","),
    );
    const after = await fs.readFile(path.join(fixtureDir, "math.mjs"), "utf8");
    assert.match(after, /a \+ b/);
    assert.doesNotMatch(after, /a \* b/);
    // Verify tests actually pass in the fixture
    const { spawn } = await import("node:child_process");
    const code = await new Promise((resolve) => {
      const child = spawn("node", ["--test", "test.mjs"], {
        cwd: fixtureDir,
        shell: true,
      });
      child.on("close", resolve);
    });
    assert.equal(code, 0, "fixture tests still failing after Jack");
    const reply = transcript(events);
    assert.doesNotMatch(reply, /cannot control|as an AI I cannot/i);
    pass(
      "B AUTO DEVELOPER",
      `tools=${toolsUsed.join(",")} replyChars=${reply.length}`,
    );
    console.log("--- developer reply preview ---\n" + reply.slice(0, 900) + "\n---");
  } catch (error) {
    fail("B AUTO DEVELOPER", error.message || error);
  }

  // Gaming Mode unload
  try {
    const gaming = await fetch(`http://127.0.0.1:${port}/api/gaming`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CoffeeJack-Token": token,
      },
      body: JSON.stringify({ enabled: true }),
    });
    const body = await gaming.json();
    assert.equal(gaming.status, 200);
    assert.equal(body.gaming, true);
    assert.ok(Array.isArray(body.unloaded));
    const blocked = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CoffeeJack-Token": token,
      },
      body: JSON.stringify({ text: "hello while gaming" }),
    });
    assert.equal(blocked.status, 409);
    await fetch(`http://127.0.0.1:${port}/api/gaming`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CoffeeJack-Token": token,
      },
      body: JSON.stringify({ enabled: false }),
    });
    pass("Gaming Mode unloads and blocks chat", JSON.stringify(body.unloaded));
  } catch (error) {
    fail("Gaming Mode", error.message || error);
  }

  // No temporary acceptance noise saved
  assert.equal(
    app.store.memories().filter((m) => /acceptance|temporary fixture/i.test(m.content))
      .length,
    0,
  );
  pass("No acceptance-test memories stored");

  await app.close();
} catch (error) {
  fail("setup", error.message || error);
} finally {
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log("\nSUMMARY", results.filter((r) => r.ok).length + "/" + results.length);
if (failed.length) {
  process.exitCode = 1;
  console.error(failed);
}
