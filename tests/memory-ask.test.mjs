import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/index.mjs";
import {
  applyAutomaticMemory,
  createMemoryProposalStore,
  extractMemories,
  commitMemoryItem,
} from "../server/auto-memory.mjs";
import { getPreferences, savePreferences } from "../server/preferences.mjs";
import { runAgent } from "../server/agent.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-ask-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, store };
}

test("Ask mode queues pending memories without saving", async (t) => {
  const { store } = await fixture(t);
  savePreferences(store, { memoryBehavior: "ask" });
  const result = applyAutomaticMemory(
    store,
    "From now on call me Lord and keep answers concise.",
    { behavior: "ask", preferences: getPreferences(store) },
  );
  assert.ok(result.pending.length >= 1);
  assert.equal(result.saved.length, 0);
  assert.equal(store.memories().length, 0);
  assert.equal(getPreferences(store).address, "master");
});

test("proposal save / discard / edit resolve correctly", async (t) => {
  const { store } = await fixture(t);
  const proposals = createMemoryProposalStore(store);
  const [pending] = proposals.enqueue(
    [
      {
        content: "Address preference: Lord",
        type: "preference",
        kind: "preference",
        setting: { address: "lord" },
        confidence: 0.95,
      },
    ],
    "chat-1",
  );
  assert.equal(proposals.size(), 1);
  const discarded = proposals.resolve(
    proposals.enqueue(
      [
        {
          content: "Uses Windows",
          type: "environment",
          kind: "note",
          confidence: 0.9,
        },
      ],
      null,
    )[0].id,
    "discard",
  );
  assert.equal(discarded.action, "discard");
  assert.equal(store.memories().length, 0);

  const edited = proposals.resolve(pending.id, "edit", "Address preference: Sir");
  assert.equal(edited.action, "edit");
  assert.equal(edited.content, "Address preference: Sir");
  assert.equal(store.memories().length, 1);
  assert.equal(getPreferences(store).address, "master");
  assert.equal(proposals.size(), 0);
});

test("save applies preference setting from proposal", async (t) => {
  const { store } = await fixture(t);
  const proposals = createMemoryProposalStore(store);
  const [item] = proposals.enqueue([
    {
      content: "Prefers concise answers",
      type: "preference",
      kind: "preference",
      setting: { verbosity: "concise" },
      confidence: 0.9,
    },
  ]);
  const saved = proposals.resolve(item.id, "save");
  assert.equal(saved.action, "save");
  assert.equal(getPreferences(store).verbosity, "concise");
  assert.ok(store.memories().some((m) => /concise/i.test(m.content)));
});

test("ephemeral acceptance text is not extracted", () => {
  assert.equal(
    extractMemories(
      "This acceptance-test temporary fixture project uses Windows.",
    ).length,
    0,
  );
  assert.ok(extractMemories("I use Windows").length >= 1);
});

test("HTTP memory-proposals endpoint save and discard", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-ask-http-"));
  const app = await createApp({
    dataDirectory: dir,
    ollama: {
      models: async () => [{ name: "test" }],
      inspect: async () => ({ capabilities: ["tools"] }),
      unload: async () => ["test"],
      chat: async ({ onToken }) => {
        onToken("At your service.");
        return { role: "assistant", content: "At your service.", tokens: 2 };
      },
    },
  });
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  savePreferences(app.store, { memoryBehavior: "ask", mode: "auto" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = app.server.address().port;
  const token = app.token;
  const events = [];
  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": token,
    },
    body: JSON.stringify({
      text: "From now on call me Lord",
      requestedMode: "auto",
      requestedModel: "auto",
      mode: "auto",
    }),
  });
  assert.equal(response.ok, true);
  const text = await response.text();
  for (const line of text.split("\n").filter(Boolean))
    events.push(JSON.parse(line));
  const memory = events.find((e) => e.type === "memory");
  assert.ok(memory);
  assert.ok(memory.pending?.length >= 1);
  assert.ok(memory.pending[0].id);
  assert.equal(app.store.memories().length, 0);
  assert.ok(events.some((e) => e.type === "done" || e.type === "token"));

  const save = await fetch(
    `http://127.0.0.1:${port}/api/memory-proposals/${memory.pending[0].id}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CoffeeJack-Token": token,
      },
      body: JSON.stringify({ action: "save" }),
    },
  );
  assert.equal(save.status, 200);
  assert.equal(getPreferences(app.store).address, "lord");
  assert.ok(app.store.memories().length >= 1);
});

test("agent Ask proposals do not block completion", async (t) => {
  const { dir, store } = await fixture(t);
  savePreferences(store, { memoryBehavior: "ask" });
  const proposals = createMemoryProposalStore(store);
  const emitted = [];
  await runAgent({
    store,
    chatId: store.createChat("ask").id,
    text: "Call me Lord please",
    model: "test",
    signal: new AbortController().signal,
    emit: (e) => emitted.push(e),
    memoryProposals: proposals,
    tools: { workspace: dir, execute: async () => ({}) },
    ollama: {
      chat: async ({ onToken }) => {
        onToken("Noted.");
        return { role: "assistant", content: "Noted.", tokens: 1 };
      },
    },
  });
  const memory = emitted.find((e) => e.type === "memory");
  assert.ok(memory?.pending?.length);
  assert.ok(emitted.some((e) => e.type === "done"));
  assert.equal(store.memories().length, 0);
  assert.equal(proposals.size(), memory.pending.length);
});

test("commitMemoryItem rejects secrets", async (t) => {
  const { store } = await fixture(t);
  assert.throws(
    () =>
      commitMemoryItem(store, {
        content: "api_key: sk-abcdefghijklmnopqrstuvwxyz",
        kind: "note",
      }),
  );
});
