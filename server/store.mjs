import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { projectKey, validateMemory, retrieveMemories } from "./memory.mjs";

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, "coffeejack.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, kind TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, tool TEXT NOT NULL, detail TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL);`);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS task_states (chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE, state TEXT NOT NULL, updated TEXT NOT NULL)",
    );
    if (
      !this.db
        .prepare("PRAGMA table_info(memories)")
        .all()
        .some((column) => column.name === "project")
    )
      this.db.exec("ALTER TABLE memories ADD COLUMN project TEXT");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS memories_project ON memories(project)",
    );
  }
  taskState(chatId) {
    const row = this.db
      .prepare("SELECT state FROM task_states WHERE chat_id=?")
      .get(chatId);
    return row ? JSON.parse(row.state) : null;
  }
  saveTaskState(chatId, state) {
    this.db
      .prepare("INSERT OR REPLACE INTO task_states VALUES(?,?,?)")
      .run(chatId, JSON.stringify(state), new Date().toISOString());
  }
  relevantMemories(query, options) {
    return retrieveMemories(this.db, query, options);
  }
  get(key, fallback) {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES (?,?)")
      .run(key, JSON.stringify(value));
  }
  chats() {
    return this.db.prepare("SELECT * FROM chats ORDER BY created DESC").all();
  }
  createChat(title) {
    const c = {
      id: randomUUID(),
      title: title.slice(0, 80),
      created: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO chats VALUES (?,?,?)")
      .run(c.id, c.title, c.created);
    return c;
  }
  chat(id) {
    return this.db.prepare("SELECT * FROM chats WHERE id=?").get(id);
  }
  messages(id) {
    return this.db
      .prepare(
        "SELECT role,content,created FROM messages WHERE chat_id=? ORDER BY id",
      )
      .all(id);
  }
  message(id, role, content) {
    this.db
      .prepare(
        "INSERT INTO messages(chat_id,role,content,created) VALUES(?,?,?,?)",
      )
      .run(id, role, content, new Date().toISOString());
  }
  deleteChat(id) {
    this.db.prepare("DELETE FROM chats WHERE id=?").run(id);
  }
  memories(query = "") {
    return this.db
      .prepare(
        "SELECT * FROM memories WHERE content LIKE ? ORDER BY created DESC LIMIT 100",
      )
      .all(`%${query}%`);
  }
  remember(content, kind = "note", project = null) {
    content = validateMemory(content, kind);
    const scope = kind === "preference" ? null : projectKey(project);
    const existing = this.db
      .prepare(
        "SELECT id FROM memories WHERE content=? AND kind=? AND project IS ?",
      )
      .get(content, kind, scope);
    if (existing) return existing.id;
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO memories(id,content,kind,created,project) VALUES(?,?,?,?,?)",
      )
      .run(id, content, kind, new Date().toISOString(), scope);
    return id;
  }
  forget(id) {
    this.db.prepare("DELETE FROM memories WHERE id=?").run(id);
  }
  event(chatId, tool, detail, status) {
    this.db
      .prepare(
        "INSERT INTO events(chat_id,tool,detail,status,created) VALUES(?,?,?,?,?)",
      )
      .run(
        chatId ?? null,
        tool,
        JSON.stringify(detail).slice(0, 20000),
        status,
        new Date().toISOString(),
      );
  }
  events() {
    return this.db
      .prepare("SELECT * FROM events ORDER BY id DESC LIMIT 100")
      .all();
  }
  close() {
    this.db.close();
  }
  counts() {
    return {
      memories: this.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n,
      conversations: this.db.prepare("SELECT COUNT(*) AS n FROM chats").get().n,
      completedTools: this.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE status='done'")
        .get().n,
    };
  }
}
