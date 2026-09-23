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
    councilMode: "auto",
    remoteAi: "allowed",
    councilMaxModels: "2",
    remoteBudget: "conservative",
    councilOtherModels: "on",
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = app.server.address().port;
  const token = app.token;

  // Providers status (no keys required)
  try {
    const providersRes = await fetch(`http://127.0.0.1:${port}/api/providers`, {
      headers: { "X-CoffeeJack-Token": token },
    });
    assert.equal(providersRes.status, 200);
    const providersBody = await providersRes.json();
    assert.ok(providersBody.providers.some((p) => p.id === "ollama"));
    assert.ok(providersBody.providers.some((p) => p.id === "openai"));
    const openai = providersBody.providers.find((p) => p.id === "openai");
    assert.ok(
      openai.status === "not_configured" || openai.status === "unavailable",
    );
    pass("Providers API lists Ollama + unconfigured remotes");
  } catch (error) {
    fail("Providers API", error.message || error);
  }

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

  // A — Coding with mock second local council model → evidence Round 2
  try {
    savePreferences(app.store, { councilMode: "on", councilOtherModels: "on" });
    if (!app.registry.getProvider("live-reviewer")) {
      app.registry.register({
        id: "live-reviewer",
        name: "Live Reviewer",
        type: "local",
        privacyClass: "local",
        enabled: true,
        listModels: async () => [
          {
            id: "reviewer-local",
            capabilities: ["tools", "reasoning"],
            local: true,
            costTier: "free",
            speedTier: "fast",
          },
        ],
        health: async () => ({ available: true, latencyMs: 1 }),
        chat: async () => ({
          content:
            "Evidence supports the fix. Tests passed. No regression visible from the evidence pack.",
        }),
      });
    }
    await app.registry.refresh();
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
        "and report only verified success.",
      requestedMode: "auto",
      requestedModel: "auto",
      mode: "auto",
    });
    const routing = events.find((e) => e.type === "routing");
    assert.match(routing?.model || "", /qwen3:8b/);
    const councilEvents = events.filter((e) => e.type === "council");
    const review = councilEvents.find(
      (e) => e.evidenceRound || /Evidence round|Council Review/i.test(e.title + e.detail),
    );
    assert.ok(
      councilEvents.some((e) => e.status === "done") || review,
      "expected council and/or evidence review events",
    );
    if (review && review.status === "done") {
      assert.match(String(review.detail || ""), /Evidence round|Participants/i);
    }
    const after = await fs.readFile(path.join(fixtureDir, "math.mjs"), "utf8");
    assert.match(after, /a \+ b/);
    const reply = transcript(events);
    assert.match(reply, /Verification|tests passed|passed/i);
    assert.doesNotMatch(reply, /cannot control|as an AI I cannot/i);
    const { spawn } = await import("node:child_process");
    const code = await new Promise((resolve) => {
      const child = spawn("node", ["--test", "test.mjs"], {
        cwd: fixtureDir,
        shell: true,
      });
      child.on("close", resolve);
    });
    assert.equal(code, 0, "fixture tests still failing after Jack");
    pass(
      "A CODING EVIDENCE ROUND",
      `council=${councilEvents.length} review=${review?.detail || "n/a"}`,
    );
    // Remove mock council model so later one-model checks stay accurate.
    app.registry.providers.delete("live-reviewer");
    app.registry.models.delete("live-reviewer");
    app.registry.statuses.delete("live-reviewer");
    await app.registry.refresh();
    savePreferences(app.store, { councilMode: "auto" });
  } catch (error) {
    fail("A CODING EVIDENCE ROUND", error.message || error);
  }

  // B — Deliberately failing tests must not claim success
  try {
    const failDir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-live-fail-"));
    await makeBuggyProject(failDir);
    // Keep the bug; ask Jack only to run tests and report.
    await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CoffeeJack-Token": token,
      },
      body: JSON.stringify({
        workspace: failDir,
        autoApprove: true,
        model: "qwen3:8b",
      }),
    });
    const events = await streamChat(port, token, {
      text:
        "acceptance-test temporary fixture: Run the project tests only and report whether they passed. Do not modify files.",
      requestedMode: "auto",
      requestedModel: "auto",
    });
    const reply = transcript(events);
    const toolsUsed = events.filter((e) => e.type === "tool").map((e) => e.name);
    assert.ok(
      toolsUsed.includes("run_tests") || /test/i.test(reply),
      "expected test execution or report",
    );
    assert.doesNotMatch(
      reply,
      /Verification\nVerified: tests passed/i,
    );
    // Soft check: should not celebrate success without evidence
    if (/Verification/i.test(reply)) {
      assert.match(reply, /did not pass|not claimed|fail/i);
    }
    pass("B FAILING TESTS NO SUCCESS CLAIM", reply.slice(0, 120));
    await fs.rm(failDir, { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    fail("B FAILING TESTS NO SUCCESS CLAIM", error.message || error);
  }

  // D — Council with one model must not fake participants
  try {
    savePreferences(app.store, { councilMode: "on" });
    const events = await streamChat(port, token, {
      text: "ask the council to compare architecture approaches carefully",
      requestedMode: "auto",
      requestedModel: "auto",
    });
    const council = events.find((e) => e.type === "council");
    assert.ok(council);
    assert.equal(council.status, "skipped");
    assert.match(
      String(council.detail || ""),
      /1 model available|consultation skipped|one_model|insufficient/i,
    );
    const reply = transcript(events);
    assert.doesNotMatch(reply, /\bClaude says\b|\bGPT says\b/i);
    pass("D COUNCIL ONE MODEL", council.detail);
    savePreferences(app.store, { councilMode: "auto" });
  } catch (error) {
    fail("D COUNCIL ONE MODEL", error.message || error);
  }

  // E — Remote Never never selects remote provider
  try {
    savePreferences(app.store, { remoteAi: "never" });
    const events = await streamChat(port, token, {
      text: "hello",
      requestedMode: "auto",
      requestedModel: "auto",
    });
    const routing = events.find((e) => e.type === "routing");
    assert.equal(routing?.provider || "ollama", "ollama");
    assert.match(routing?.model || "", /qwen3:8b/);
    pass("E REMOTE NEVER", `provider=${routing.provider}`);
    savePreferences(app.store, { remoteAi: "allowed" });
  } catch (error) {
    fail("E REMOTE NEVER", error.message || error);
  }

  // C — AUTO RESEARCH
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
      "C AUTO RESEARCH",
      `model=${routing.model} tools=${researchTools.length} chars=${reply.length} verification=${/Verification/i.test(reply)}`,
    );
    console.log("--- research reply preview ---\n" + reply.slice(0, 900) + "\n---");
  } catch (error) {
    fail("C AUTO RESEARCH", error.message || error);
  }

  // F — provider failure fallback (unit-level against live registry)
  try {
    const { routeModel } = await import("../server/router.mjs");
    const route = await routeModel({
      ollama: app.ollama,
      registry: app.registry,
      settings: { model: "qwen3:8b" },
      text: "hello",
      previousFailures: ["missing-remote:gpt"],
      preferences: { remoteAi: "never" },
    });
    assert.match(route.model, /qwen3:8b/);
    assert.equal(route.provider, "ollama");
    pass("F PROVIDER FAILURE FALLBACK", route.reasonCode);
  } catch (error) {
    fail("F PROVIDER FAILURE FALLBACK", error.message || error);
  }

  // G — partial council failure (mocked participants via registry path)
  try {
    const { runCouncil } = await import("../server/council.mjs");
    const result = await runCouncil({
      participants: [
        { modelId: "qwen3:8b", providerId: "ollama", role: "primary", local: true },
        { modelId: "missing", providerId: "ollama", role: "critic", local: true },
        { modelId: "qwen3:8b", providerId: "ollama", role: "specialist", local: true },
      ],
      prompt: "compare approaches",
      chatFn: async ({ modelId }) => {
        if (modelId === "missing") throw new Error("timeout");
        return { content: `ok from ${modelId}` };
      },
    });
    // Distinctness would normally prevent duplicate qwen — this tests partial failure handling.
    assert.equal(result.succeeded, 2);
    assert.equal(result.rejected, 1);
    assert.ok(result.synthesis);
    pass("G PARTIAL COUNCIL FAILURE", `${result.succeeded}/${result.requested}`);
  } catch (error) {
    fail("G PARTIAL COUNCIL FAILURE", error.message || error);
  }

  // Remote live smoke — only if credentials exist
  try {
    const hasRemote =
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GEMINI_API_KEY;
    if (!hasRemote) {
      pass("REMOTE LIVE SMOKE", "skipped: no credentials");
    } else {
      await app.registry.refresh();
      const remote = app.registry
        .listModels({ remoteAllowed: true })
        .find((m) => !m.local);
      assert.ok(remote, "configured key but no remote models listed");
      const reply = await app.registry.chat({
        providerId: remote.provider,
        modelId: remote.id,
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
        signal: AbortSignal.timeout(45000),
      });
      assert.ok(String(reply.content || "").length > 0);
      pass(
        "REMOTE LIVE SMOKE",
        `${remote.provider}/${remote.id} chars=${reply.content.length}`,
      );
    }
  } catch (error) {
    fail("REMOTE LIVE SMOKE", error.message || error);
  }

  // H — Gaming Mode unload + council suppressed / chat blocked
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
    pass("D GAMING MODE", JSON.stringify(body.unloaded));
  } catch (error) {
    fail("D GAMING MODE", error.message || error);
  }

  // No temporary acceptance noise saved (verified coding lessons from the fixture are allowed)
  assert.equal(
    app.store
      .memories()
      .filter(
        (m) =>
          m.kind !== "lesson" &&
          /acceptance|temporary fixture/i.test(m.content),
      ).length,
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
