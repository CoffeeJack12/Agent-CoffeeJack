import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { workspacePath } from "../server/files.mjs";
import { createApp } from "../server/index.mjs";
import { Tools, definitions, runProcess } from "../server/tools.mjs";
import { runAgent } from "../server/agent.mjs";

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coffeejack-test-"));
  t.cleanup = [];
  t.after(async () => {
    for (const dispose of t.cleanup.reverse()) await dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("workspace confines writes, blocks secrets and rejects junction escapes", async (t) => {
  const dir = await temporary(t);
  const root = path.join(dir, "project");
  const outside = path.join(dir, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  assert.equal(
    await workspacePath(root, "src/hello.txt", { write: true }),
    path.join(await fs.realpath(root), "src", "hello.txt"),
  );
  for (const p of [
    "../outside/file",
    ".env",
    ".git/config",
    ".GIT/config",
    ".ENV",
    ".git /config",
    "C:\\Windows\\file",
    "data:secret",
  ])
    await assert.rejects(workspacePath(root, p, { write: true }));
  await fs.symlink(
    outside,
    path.join(root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    workspacePath(root, "escape/file", { write: true }),
    /outside/,
  );
});
test("memories and conversations persist and deletion cascades", async (t) => {
  const dir = await temporary(t);
  let store = new Store(dir);
  const chat = store.createChat("hello");
  store.message(chat.id, "user", "مرحبا");
  store.remember("I like concise Arabic", "preference");
  store.close();
  store = new Store(dir);
  assert.equal(store.messages(chat.id)[0].content, "مرحبا");
  assert.equal(store.memories("Arabic").length, 1);
  store.deleteChat(chat.id);
  assert.equal(store.messages(chat.id).length, 0);
  store.close();
});
test("agent executes tool calls and feeds errors back for repair", async (t) => {
  const store = new Store(await temporary(t));
  t.cleanup.push(() => store.close());
  const chat = store.createChat("build");
  let calls = 0;
  const events = [];
  const ollama = {
    chat: async (args) => {
      calls++;
      if (calls === 1)
        return {
          role: "assistant",
          content: "",
          tokens: 1,
          tool_calls: [
            {
              function: {
                name: "read_file",
                arguments: { path: "missing.txt" },
              },
            },
          ],
        };
      assert.match(args.messages.at(-1).content, /missing/);
      args.onToken("I found the error.");
      return { role: "assistant", content: "I found the error.", tokens: 4 };
    },
  };
  await runAgent({
    store,
    ollama,
    tools: {
      workspace: "test",
      execute: async () => {
        throw new Error("missing file");
      },
    },
    chatId: chat.id,
    text: "Build",
    model: "test",
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
  });
  assert.equal(calls, 2);
  assert.equal(store.events()[0].status, "error");
  assert.equal(store.messages(chat.id).length, 2);
  assert.equal(events.at(-1).type, "done");
});
test("HTTP origin/token checks, memory persistence, gaming block and streaming chat", async (t) => {
  const dir = await temporary(t);
  let unloaded = false;
  const fake = {
    models: async () => [{ name: "test" }],
    inspect: async () => ({ capabilities: ["tools"] }),
    unload: async () => {
      unloaded = true;
      return ["test"];
    },
    chat: async ({ onToken }) => {
      onToken("Hello Jack");
      return { role: "assistant", content: "Hello Jack", tokens: 2 };
    },
  };
  const app = await createApp({ dataDirectory: dir, ollama: fake });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const send = (route, body, headers = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CoffeeJack-Token": app.token,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await send(
        "/api/memories",
        { content: "x" },
        { Origin: "https://malicious.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await send(
        "/api/memories",
        { content: "x" },
        { "X-CoffeeJack-Token": "wrong" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await send("/api/memories", { content: "Arabic please" })).status,
    200,
  );
  const authenticated = {
    headers: { "X-CoffeeJack-Token": app.token },
  };
  assert.equal(
    (await (await fetch(base + "/api/memories", authenticated)).json()).length,
    1,
  );
  await send("/api/gaming", { enabled: true });
  assert.equal(unloaded, true);
  assert.equal((await send("/api/chat", { text: "hello" })).status, 409);
  await send("/api/gaming", { enabled: false });
  const response = await send("/api/chat", { text: "hello" });
  const events = (await response.text()).trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).type, "timing");
  assert.equal(events.find((e) => e.type === "done")?.type, "done");
  assert.equal(events.find((e) => e.type === "token").text, "Hello Jack");
  const chats = await (await fetch(base + "/api/chats", authenticated)).json();
  assert.equal(chats.length, 1);
  assert.equal(
    (await fetch(base + "/api/chats/missing", authenticated)).status,
    404,
  );
});
test("pending tool approval is cancelled when gaming mode starts", async (t) => {
  const dir = await temporary(t);
  let emitted = false;
  const fake = {
    models: async () => [{ name: "test" }],
    inspect: async () => ({ capabilities: ["tools"] }),
    unload: async () => [],
    chat: async () => {
      emitted = true;
      return {
        role: "assistant",
        content: "",
        tokens: 0,
        tool_calls: [
          {
            function: {
              name: "terminal",
              arguments: { command: "Remove-Item -Force test.txt" },
            },
          },
        ],
      };
    },
  };
  const app = await createApp({ dataDirectory: dir, ollama: fake });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (r, b) =>
    fetch(base + r, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CoffeeJack-Token": app.token,
      },
      body: JSON.stringify(b),
    });
  const stream = await post("/api/chat", { text: "write" });
  const reader = stream.body.getReader();
  let text = "";
  while (!text.includes('"approval"')) {
    const v = await reader.read();
    text += new TextDecoder().decode(v.value);
  }
  assert.equal(emitted, true);
  assert.equal((await post("/api/gaming", { enabled: true })).status, 200);
  await assert.rejects(fs.stat(path.join(dir, "projects", "test.txt")));
  await reader.cancel();
});

async function agentSequence(t, argumentsList, execute) {
  const dir = await temporary(t);
  const store = new Store(dir);
  t.cleanup.push(() => store.close());
  const feedback = [];
  let round = 0;
  let executed = 0;
  await runAgent({
    store,
    chatId: store.createChat("behavior").id,
    text: "Test coding workflow",
    model: "test",
    signal: new AbortController().signal,
    emit: () => {},
    tools: {
      workspace: dir,
      execute: async (...args) => {
        executed++;
        return execute(executed, ...args);
      },
    },
    ollama: {
      chat: async ({ messages }) => {
        if (round) feedback.push(JSON.parse(messages.at(-1).content));
        if (round === argumentsList.length)
          return { role: "assistant", content: "done", tokens: 0 };
        return {
          role: "assistant",
          content: "",
          tokens: 0,
          tool_calls: [
            {
              function: { name: "terminal", arguments: argumentsList[round++] },
            },
          ],
        };
      },
    },
  });
  return { executed, feedback, reflection: store.get("lastReflection") };
}

test("anti-loop blocks the fourth identical failure before execution", async (t) => {
  const result = await agentSequence(
    t,
    Array(4).fill({ command: "fail" }),
    () => {
      throw new Error("failed");
    },
  );
  assert.equal(result.executed, 3);
  assert.equal(result.feedback[3].blocked, true);
  assert.equal(result.feedback[3].previousFailures, 3);
  assert.match(result.feedback[3].error, /different strategy/);
  assert.equal(result.reflection.outcome, "completed");
});

test("anti-loop normalizes nested argument keys and JSON string arguments", async (t) => {
  const a = { command: "fail", nested: { a: 1, b: [2, 3] } };
  const b = { nested: { b: [2, 3], a: 1 }, command: "fail" };
  const result = await agentSequence(t, [a, b, JSON.stringify(b), a], () => {
    throw new Error("failed");
  });
  assert.equal(result.executed, 3);
  assert.equal(result.feedback[3].blocked, true);
});

test("successful identical calls remain allowed and clear previous failures", async (t) => {
  const result = await agentSequence(
    t,
    Array(11).fill({ command: "same" }),
    (n) => {
      if ([1, 2, 8, 9, 10].includes(n)) throw new Error("transient");
      return { code: 0, output: "ok" };
    },
  );
  assert.equal(result.executed, 10);
  assert.equal(result.feedback[9].blocked, false);
  assert.equal(result.feedback[10].blocked, true);
  assert.equal(result.reflection.successfulTools, 5);
});

test("nonzero process results participate in anti-loop protection", async (t) => {
  const result = await agentSequence(
    t,
    Array(4).fill({ command: "fail" }),
    () => ({ code: 1, output: "actual failure" }),
  );
  assert.equal(result.executed, 3);
  assert.match(result.feedback[0].error, /actual failure/);
  assert.equal(result.feedback[3].blocked, true);
});

function makeTools(workspace, approve = async () => {}) {
  return new Tools({
    root: workspace,
    workspace,
    approve,
    artifactDirectory: workspace,
  });
}
const toolSignal = () => new AbortController().signal;

test("search_code finds nested matches and excludes protected paths and junctions", async (t) => {
  const dir = await temporary(t);
  const root = path.join(dir, "project");
  for (const folder of [
    "src/deep",
    ".git",
    "node_modules",
    ".local",
    "outside",
  ])
    await fs.mkdir(path.join(root, folder), { recursive: true });
  for (const file of [
    ".git/secret.js",
    "node_modules/secret.js",
    ".local/secret.js",
    ".env",
    ".env.something",
    ".ENV.Other",
  ])
    await fs.writeFile(path.join(root, file), "needle");
  await fs.writeFile(
    path.join(root, "src/deep/example.js"),
    "before\nneedle here\nafter\n",
  );
  const outside = path.join(dir, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.js"), "needle");
  await fs.symlink(
    outside,
    path.join(root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await fs.symlink(
    path.join(root, ".local"),
    path.join(root, "internal-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const tools = makeTools(root);
  const result = await tools.execute(
    "search_code",
    { query: "needle" },
    toolSignal(),
  );
  assert.equal(result.count, 1);
  assert.deepEqual(result.results[0], {
    path: "src/deep/example.js",
    lineNumber: 2,
    matchingLine: "needle here",
    context: ["    before", ">>> needle here", "    after", "    "],
  });
  assert.equal(
    (
      await tools.execute(
        "search_code",
        { query: "needle", path: "src/deep" },
        toolSignal(),
      )
    ).count,
    1,
  );
  assert.equal(
    (
      await tools.execute(
        "search_code",
        { query: "needle", path: ".local" },
        toolSignal(),
      )
    ).count,
    0,
  );
  for (const query of ["", "   ", "x".repeat(1001), 7])
    await assert.rejects(
      tools.execute("search_code", { query }, toolSignal()),
      /query/,
    );
  await assert.rejects(
    tools.execute(
      "search_code",
      { query: "needle", path: "escape" },
      toolSignal(),
    ),
    /outside/,
  );
  await fs.writeFile(path.join(root, "many.js"), "needle\n".repeat(70));
  const capped = await tools.execute(
    "search_code",
    { query: "needle" },
    toolSignal(),
  );
  assert.equal(capped.count, 50);
  assert.equal(capped.limited, true);
});

async function gitFixture(t) {
  const dir = await temporary(t);
  const git = async (args) => {
    const result = await runProcess("git", args, { cwd: dir });
    assert.equal(result.code, 0, result.output);
    return result;
  };
  await git(["init"]);
  await fs.writeFile(path.join(dir, "first.txt"), "baseline first\n");
  await fs.writeFile(path.join(dir, "second.txt"), "baseline second\n");
  await git(["add", "first.txt", "second.txt"]);
  await git([
    "-c",
    "user.name=CoffeeJack Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
  return { dir, tools: makeTools(dir) };
}

test("git_status reports actual clean and modified files and rejects non-repos", async (t) => {
  const { dir, tools } = await gitFixture(t);
  assert.equal(
    (await tools.execute("git_status", {}, toolSignal())).status,
    "clean",
  );
  await fs.writeFile(path.join(dir, "first.txt"), "changed first\n");
  const result = await tools.execute("git_status", {}, toolSignal());
  assert.equal(result.status, "modified");
  assert.ok(result.changes.some((line) => line.includes("first.txt")));
  const empty = makeTools(await temporary(t));
  await assert.rejects(
    empty.execute("git_status", {}, toolSignal()),
    /git status failed/,
  );
  await assert.rejects(
    empty.execute("git_diff", {}, toolSignal()),
    /git diff failed/,
  );
});

test("git_diff returns real diffs and confines optional literal paths", async (t) => {
  const { dir, tools } = await gitFixture(t);
  await fs.writeFile(path.join(dir, "first.txt"), "changed first\n");
  await fs.writeFile(path.join(dir, "second.txt"), "changed second\n");
  const all = await tools.execute("git_diff", {}, toolSignal());
  assert.match(all.diff, /changed first/);
  assert.match(all.diff, /changed second/);
  const one = await tools.execute(
    "git_diff",
    { path: "first.txt" },
    toolSignal(),
  );
  assert.match(one.diff, /changed first/);
  assert.doesNotMatch(one.diff, /second.txt/);
  await fs.unlink(path.join(dir, "first.txt"));
  assert.match(
    (await tools.execute("git_diff", { path: "first.txt" }, toolSignal())).diff,
    /deleted file/,
  );
  for (const p of ["../outside", ".env", ".git/config"])
    await assert.rejects(tools.execute("git_diff", { path: p }, toolSignal()));
});

test("run_tests executes npm with flat arguments, filters and approval", async (t) => {
  const dir = await temporary(t);
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { test: "node test.cjs" } }),
  );
  await fs.writeFile(
    path.join(dir, "test.cjs"),
    'console.log("TEST_EXECUTED", JSON.stringify(process.argv.slice(2))); if(process.argv.includes("fail")) process.exitCode=1;',
  );
  const approvals = [];
  const tools = makeTools(dir, async (name) => approvals.push(name));
  const normal = await tools.execute("run_tests", {}, toolSignal());
  assert.equal(normal.code, 0, normal.output);
  assert.match(normal.output, /TEST_EXECUTED \[\]/);
  const filter = 'space & whoami | echo %PATH% "quote"';
  const filtered = await tools.execute(
    "run_tests",
    { testFilter: filter },
    toolSignal(),
  );
  assert.equal(filtered.code, 0, filtered.output);
  assert.ok(
    filtered.output.includes(JSON.stringify([filter])),
    filtered.output,
  );
  const failed = await tools.execute(
    "run_tests",
    { testFilter: "fail" },
    toolSignal(),
  );
  assert.equal(failed.code, 1);
  assert.deepEqual(approvals, ["run_tests", "run_tests", "run_tests"]);
  await fs.unlink(path.join(dir, "test.cjs"));
  const denied = makeTools(dir, async () => {
    throw new Error("approval denied");
  });
  await assert.rejects(
    denied.execute("run_tests", {}, toolSignal()),
    /approval denied/,
  );
});

test("terminal runs a real platform shell command", async (t) => {
  const tools = makeTools(await temporary(t));
  const command =
    process.platform === "win32" ? "Write-Output (6 * 7)" : "printf 42";
  const result = await tools.execute("terminal", { command }, toolSignal());
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trim(), "42");
});

test("optional tool parameters have accurate schemas", () => {
  const required = (name) =>
    definitions.find((d) => d.function.name === name).function.parameters
      .required;
  assert.deepEqual(required("search_code"), ["query"]);
  assert.deepEqual(required("git_diff"), []);
  assert.deepEqual(required("run_tests"), []);
});
