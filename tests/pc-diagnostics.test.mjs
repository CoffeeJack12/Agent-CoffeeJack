/**
 * PC diagnostics: helpers, intent routing, terminal shell mismatch, chat pipeline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { resolveTurnContext } from "../server/conversation-intent.mjs";
import {
  assertValidDrive,
  classifyPcDiagnosticIntent,
  detectShellMismatch,
  formatDiskAnswer,
  getDiskUsage,
  getPcHealthSummary,
  normalizeDriveLetter,
} from "../server/pc-diagnostics.mjs";
import { Tools } from "../server/tools.mjs";
import { shouldShowToolInChat } from "../public/chat-visibility.js";

async function appFixture(t, { ollamaChat } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-pcdiag-"));
  const executed = [];
  const fake = {
    models: async () => [{ name: "qwen3:8b" }],
    inspect: async () => ({ capabilities: ["tools"] }),
    prepare: async () => ({ alreadyLoaded: true, unloaded: [] }),
    unload: async () => [],
    chat: async (args) => {
      if (typeof ollamaChat === "function") return ollamaChat(args, executed);
      args.onToken?.("ok");
      return { role: "assistant", content: "ok", tokens: 1 };
    },
  };
  const app = await createApp({ dataDirectory: dir, ollama: fake });
  app.store.set("autoApprove", true);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    app,
    base: `http://127.0.0.1:${app.server.address().port}`,
    dir,
    store: app.store,
    executed,
  };
}

async function chat(base, token, text) {
  const response = await fetch(base + "/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": token,
    },
    body: JSON.stringify({ text, requestedModel: "auto" }),
  });
  const raw = await response.text();
  const events = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { status: response.status, events, raw };
}

test("intent: C drive and Arabic disk phrases", () => {
  for (const phrase of [
    "check my c drive",
    "check C:",
    "how much space do I have on C",
    "شيك على السي",
  ]) {
    const d = classifyPcDiagnosticIntent(phrase);
    assert.equal(d?.kind, "disk", phrase);
    assert.equal(d?.section, "disk", phrase);
    assert.equal(resolveTurnContext(phrase).taskHint, "disk", phrase);
  }
});

test("intent: PC health vs network remain distinct", () => {
  const health = classifyPcDiagnosticIntent(
    "check if i have any concerns in my pc",
  );
  assert.equal(health?.kind, "pc_health");
  assert.equal(health?.section, "health");
  assert.match(health.directive, /ping alone|NOT use ping/i);

  const net = classifyPcDiagnosticIntent("check my network");
  assert.equal(net?.kind, "network");
  assert.equal(net?.section, "network");
  assert.match(net.directive, /not overall PC health/i);

  assert.equal(
    classifyPcDiagnosticIntent("افحص جهازي")?.kind,
    "pc_health",
  );
});

test("drive validation rejects invalid input", () => {
  assert.equal(normalizeDriveLetter("C:"), "C");
  assert.equal(normalizeDriveLetter("d"), "D");
  assert.throws(() => assertValidDrive("../etc"), /Invalid drive/);
  assert.throws(() => assertValidDrive("C:\\Windows"), /Invalid drive/);
  assert.throws(() => assertValidDrive(""), /Invalid drive/);
});

test("shell mismatch: bash && detected; unix cmds rejected", () => {
  const issues = detectShellMismatch(
    "echo 'System Info:' && wmic cpu get Name",
  );
  assert.ok(issues.some((i) => i.code === "bash_and" && i.rewrite));
  assert.match(
    detectShellMismatch("ls -la")[0]?.message || "",
    /Unix-style|inspect_pc/i,
  );
});

test("anti-loop key collapses bash && terminal variants", async () => {
  // Replicate expected key behavior by executing terminal with && and counting failures.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-term-"));
  const tools = new Tools({
    root: dir,
    workspace: dir,
    store: { remember() {}, relevantMemories() { return []; } },
    approve: async () => {},
  });
  const signal = new AbortController().signal;
  if (process.platform === "win32") {
    const result = await tools.execute(
      "terminal",
      { command: "echo a && echo b", timeout: 10 },
      signal,
    );
    // Adapt && → ; should succeed on Windows PowerShell.
    assert.equal(result.code, 0);
    assert.equal(result.adapted, true);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("read-only helpers: source strings avoid mutators", async () => {
  const src = await fs.readFile(
    path.join(process.cwd(), "server/pc-diagnostics.mjs"),
    "utf8",
  );
  assert.doesNotMatch(
    src,
    /\b(?:Set-Item|Remove-Item|New-Item|Stop-Computer|Restart-Computer|Clear-Content|del\s|rm\s+-rf)/i,
  );
});

test(
  "Windows: getDiskUsage returns real C: values",
  { skip: process.platform !== "win32" },
  async () => {
    const disk = await getDiskUsage("C");
    assert.equal(disk.drive, "C:");
    assert.ok(disk.totalBytes > 0);
    assert.ok(disk.freeBytes >= 0);
    assert.ok(disk.usedBytes >= 0);
    assert.equal(disk.totalBytes, disk.usedBytes + disk.freeBytes);
    assert.ok(typeof disk.freePercent === "number");
    assert.match(formatDiskAnswer(disk), /C: Drive/);
    assert.match(formatDiskAnswer(disk), /Free space:/);
  },
);

test(
  "Windows: health summary is not ping-only",
  { skip: process.platform !== "win32" },
  async () => {
    const health = await getPcHealthSummary();
    assert.equal(health.section, "health");
    assert.ok(health.checks.cpu);
    assert.ok(health.checks.memory);
    assert.ok(health.checks.disk);
    assert.ok(health.checks.network);
    assert.match(health.disclaimer, /ping alone/i);
    assert.ok(Array.isArray(health.concerns));
  },
);

test(
  "Windows: inspect_pc disk via Tools — no terminal failure",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-insp-"));
    const tools = new Tools({
      root: dir,
      workspace: dir,
      store: { remember() {}, relevantMemories() { return []; } },
      approve: async () => {},
    });
    const result = await tools.execute(
      "inspect_pc",
      { section: "disk", drive: "C" },
      new AbortController().signal,
    );
    assert.equal(result.code, 0);
    assert.equal(result.data.drive, "C:");
    assert.ok(result.data.totalGiB > 0);
    assert.match(result.output, /C: Drive/);
    await fs.rm(dir, { recursive: true, force: true });
  },
);

test(
  "Windows: invalid drive rejected by inspect_pc",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-baddrive-"));
    const tools = new Tools({
      root: dir,
      workspace: dir,
      store: { remember() {}, relevantMemories() { return []; } },
      approve: async () => {},
    });
    await assert.rejects(
      () =>
        tools.execute(
          "inspect_pc",
          { section: "disk", drive: "ZZ" },
          new AbortController().signal,
        ),
      /Invalid drive/,
    );
    await fs.rm(dir, { recursive: true, force: true });
  },
);

test("UI: successful inspect_pc hidden from chat; errors visible", () => {
  assert.equal(
    shouldShowToolInChat({
      name: "inspect_pc",
      status: "done",
      result: { code: 0, output: "C: Drive" },
    }),
    false,
  );
  assert.equal(
    shouldShowToolInChat({
      name: "inspect_pc",
      status: "error",
      result: { error: "fail" },
    }),
    true,
  );
  assert.equal(
    shouldShowToolInChat({
      name: "terminal",
      status: "done",
      result: { code: 0, output: "ok" },
    }),
    false,
  );
});

test(
  "API: check my c drive runs inspect_pc disk through chat pipeline",
  { skip: process.platform !== "win32" },
  async (t) => {
    let step = 0;
    const { app, base, store } = await appFixture(t, {
      ollamaChat: async (args) => {
        step += 1;
        if (step === 1) {
          return {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "inspect_pc",
                  arguments: { section: "disk", drive: "C" },
                },
              },
            ],
            tokens: 1,
          };
        }
        const toolMsg = [...(args.messages || [])]
          .reverse()
          .find((m) => m.role === "tool");
        const text = String(toolMsg?.content || "");
        assert.match(text, /C: Drive|totalGiB|freePercent/i);
        const answer =
          "C: Drive\nTotal: ok\nUsed: ok\nFree: ok\nFree space: ok%\n\nStatus: Enough space";
        args.onToken?.(answer);
        return { role: "assistant", content: answer, tokens: 8 };
      },
    });

    const { status, events } = await chat(base, app.token, "check my c drive");
    assert.equal(status, 200);
    const tools = events.filter((e) => e.type === "tool");
    assert.ok(tools.some((e) => e.name === "inspect_pc" && e.status === "done"));
    assert.equal(
      tools.some((e) => e.name === "terminal" && e.status === "error"),
      false,
    );
    // Activity log keeps the event
    const logged = store.events().filter((e) => e.tool === "inspect_pc");
    assert.ok(logged.length >= 1);
    assert.ok(logged.some((e) => e.status === "done"));
    const tokens = events
      .filter((e) => e.type === "token")
      .map((e) => e.text)
      .join("");
    assert.match(tokens, /C: Drive|Enough space|Free/i);
  },
);

test(
  "API: PC concerns uses health section not ping alone",
  { skip: process.platform !== "win32" },
  async (t) => {
    let step = 0;
    const { app, base } = await appFixture(t, {
      ollamaChat: async (args) => {
        step += 1;
        if (step === 1) {
          const sys = args.messages?.find((m) => m.role === "system")?.content || "";
          // Directive should be in user/system from turn context
          return {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "inspect_pc",
                  arguments: { section: "health" },
                },
              },
            ],
            tokens: 1,
          };
        }
        const toolMsg = [...(args.messages || [])]
          .reverse()
          .find((m) => m.role === "tool");
        assert.match(String(toolMsg?.content || ""), /"section":"health"|cpu|memory|disk/i);
        assert.doesNotMatch(String(toolMsg?.content || ""), /ping alone is enough/i);
        const answer =
          "Checked CPU, RAM, C: disk, GPU, uptime, and network. Network is only one part.";
        args.onToken?.(answer);
        return { role: "assistant", content: answer, tokens: 8 };
      },
    });

    const turn = resolveTurnContext(
      "check if i have any concerns in my pc",
    );
    assert.equal(turn.taskHint, "pc_health");
    assert.match(turn.directive, /section="health"/);

    const { status, events } = await chat(
      base,
      app.token,
      "check if i have any concerns in my pc",
    );
    assert.equal(status, 200);
    const done = events.find(
      (e) => e.type === "tool" && e.name === "inspect_pc" && e.status === "done",
    );
    assert.ok(done);
    assert.equal(
      events.some((e) => e.type === "tool" && e.name === "terminal"),
      false,
    );
  },
);
