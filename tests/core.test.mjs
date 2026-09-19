import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { workspacePath } from "../server/files.mjs";
import { createApp } from "../server/index.mjs";
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
  assert.equal((await (await fetch(base + "/api/memories")).json()).length, 1);
  await send("/api/gaming", { enabled: true });
  assert.equal(unloaded, true);
  assert.equal((await send("/api/chat", { text: "hello" })).status, 409);
  await send("/api/gaming", { enabled: false });
  const response = await send("/api/chat", { text: "hello" });
  const events = (await response.text()).trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.find((e) => e.type === "token").text, "Hello Jack");
  const chats = await (await fetch(base + "/api/chats")).json();
  assert.equal(chats.length, 1);
  assert.equal((await fetch(base + "/api/chats/missing")).status, 404);
});
test("pending tool approval is cancelled when gaming mode starts", async (t) => {
  const dir = await temporary(t);
  let emitted = false;
  const fake = {
    models: async () => [],
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
              name: "write_file",
              arguments: { path: "test.txt", content: "hello" },
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

