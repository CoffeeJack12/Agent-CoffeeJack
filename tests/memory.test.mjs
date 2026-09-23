import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-memory-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, store };
}
test("memory ranks older relevant notes above recent unrelated notes", async (t) => {
  const { store } = await fixture(t);
  store.remember("SQLite migrations need transaction tests", "lesson");
  for (let i = 0; i < 120; i++) store.remember("Unrelated shopping item " + i);
  const result = store.relevantMemories("SQLite migrations");
  assert.equal(result.length, 1);
  assert.match(result[0].content, /SQLite/);
});
test("memory isolates projects while keeping global preferences and Arabic matching", async (t) => {
  const { store, dir } = await fixture(t);
  const a = path.join(dir, "a"),
    b = path.join(dir, "b");
  store.remember("Run migration checks for project A", "lesson", a);
  store.remember("Run migration checks for project B", "lesson", b);
  store.remember("أفضل العربية", "preference", b);
  const result = store.relevantMemories("migration", { project: a });
  assert.ok(result.some((m) => m.content.includes("project A")));
  assert.ok(result.some((m) => m.kind === "preference"));
  assert.ok(!result.some((m) => m.content.includes("project B")));
  assert.equal(store.relevantMemories("العربية")[0].content, "أفضل العربية");
});
test("memory deduplicates, respects prompt budget, and rejects known credential formats", async (t) => {
  const { store } = await fixture(t);
  const id = store.remember("Use concise replies", "preference");
  assert.equal(store.remember("Use concise replies", "preference"), id);
  for (let i = 0; i < 15; i++)
    store.remember("context " + i + "x".repeat(1200), "preference");
  const result = store.relevantMemories("context", { maxChars: 2400 });
  assert.ok(result.reduce((sum, m) => sum + m.content.length, 0) <= 2400);
  for (const content of [
    "password=testing123",
    "api_key: abc",
    "-----BEGIN RSA PRIVATE KEY-----",
    "كلمة المرور: abc",
    "https://user:pass@example.com",
  ])
    assert.throws(() => store.remember(content), /secrets/);
  assert.throws(() => store.remember(" "));
});
test("memory migrates old database without losing notes and omits legacy secrets from prompts", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-memory-old-"));
  const db = new DatabaseSync(path.join(dir, "coffeejack.sqlite"));
  db.exec(
    "CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, kind TEXT NOT NULL, created TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO memories VALUES(?,?,?,?)").run(
    "old",
    "SQLite lesson",
    "lesson",
    "2020",
  );
  db.prepare("INSERT INTO memories VALUES(?,?,?,?)").run(
    "secret",
    "password=legacy",
    "preference",
    "2020",
  );
  db.close();
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal(store.memories().length, 2);
  assert.deepEqual(
    store.relevantMemories("SQLite").map((m) => m.id),
    ["old"],
  );
});
