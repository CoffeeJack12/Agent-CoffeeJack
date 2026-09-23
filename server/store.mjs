import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { projectKey, validateMemory, retrieveMemories } from "./memory.mjs";
import { scrubStoredCapabilityClaims } from "./capabilities.mjs";
import { migrateToMultiUser, resolveLocalOwner } from "./users.mjs";

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
    this.db.exec("CREATE TABLE IF NOT EXISTS profile_preferences (profile_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
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
    for (const column of [
      ["updated", "TEXT"],
      ["last_used", "TEXT"],
      ["confidence", "REAL"],
      ["chat_id", "TEXT"],
      ["category", "TEXT"],
    ]) {
      if (
        !this.db
          .prepare("PRAGMA table_info(memories)")
          .all()
          .some((c) => c.name === column[0])
      )
        this.db.exec(`ALTER TABLE memories ADD COLUMN ${column[0]} ${column[1]}`);
    }
    scrubStoredCapabilityClaims(this);
    migrateToMultiUser(this);
  }
  profilePreferences(profileId) {
    let row = this.db.prepare("SELECT value FROM profile_preferences WHERE profile_id=?").get(profileId);
    if (!row && profileId !== "owner") {
      const owner = resolveLocalOwner(this);
      if (profileId === owner.id)
        row = this.db
          .prepare("SELECT value FROM profile_preferences WHERE profile_id='owner'")
          .get();
    } else if (!row && profileId === "owner") {
      const owner = resolveLocalOwner(this);
      row = this.db
        .prepare("SELECT value FROM profile_preferences WHERE profile_id=?")
        .get(owner.id);
    }
    return row ? JSON.parse(row.value) : {};
  }
  saveProfilePreferences(profileId, value) {
    this.db.prepare("INSERT OR REPLACE INTO profile_preferences VALUES (?,?)").run(profileId, JSON.stringify(value));
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
    return retrieveMemories(this.db, query, {
      ...options,
      userId: options?.userId ?? resolveLocalOwner(this).id,
    });
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
  chats(userId = resolveLocalOwner(this).id) {
    return this.db
      .prepare("SELECT * FROM chats WHERE user_id=? ORDER BY created DESC")
      .all(userId);
  }
  createChat(title, userId = resolveLocalOwner(this).id, workspaceId = null) {
    const c = {
      id: randomUUID(),
      title: title.slice(0, 80),
      created: new Date().toISOString(),
      user_id: userId,
      workspace_id: workspaceId || null,
    };
    try {
      const cols = this.db.prepare("PRAGMA table_info(chats)").all();
      if (!cols.some((col) => col.name === "workspace_id"))
        this.db.exec("ALTER TABLE chats ADD COLUMN workspace_id TEXT");
    } catch {
      /* ignore */
    }
    this.db
      .prepare(
        "INSERT INTO chats(id,title,created,user_id,workspace_id) VALUES (?,?,?,?,?)",
      )
      .run(c.id, c.title, c.created, c.user_id, c.workspace_id);
    return c;
  }
  chat(id, userId) {
    if (userId !== undefined)
      return this.db
        .prepare("SELECT * FROM chats WHERE id=? AND user_id=?")
        .get(id, userId);
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
  deleteChat(id, userId) {
    if (userId !== undefined)
      return (
        this.db
          .prepare("DELETE FROM chats WHERE id=? AND user_id=?")
          .run(id, userId).changes > 0
      );
    return this.db.prepare("DELETE FROM chats WHERE id=?").run(id).changes > 0;
  }
  memories(query = "", userId = resolveLocalOwner(this).id) {
    return this.db
      .prepare(
        "SELECT * FROM memories WHERE user_id=? AND content LIKE ? ORDER BY created DESC LIMIT 100",
      )
      .all(userId, `%${query}%`);
  }
  remember(content, kind = "note", project = null, meta = {}) {
    content = validateMemory(content, kind);
    const scope = kind === "preference" ? null : projectKey(project);
    const userId = meta.userId ?? resolveLocalOwner(this).id;
    const existing = this.db
      .prepare(
        "SELECT id FROM memories WHERE user_id=? AND content=? AND kind=? AND project IS ?",
      )
      .get(userId, content, kind, scope);
    if (existing) {
      this.updateMemory(existing.id, meta);
      return existing.id;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO memories(id,content,kind,created,project,updated,last_used,confidence,chat_id,category,user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        content,
        kind,
        now,
        scope,
        now,
        now,
        meta.confidence ?? null,
        meta.chatId ?? null,
        meta.category ?? null,
        userId,
      );
    return id;
  }
  updateMemory(id, meta = {}) {
    const row = this.db.prepare("SELECT * FROM memories WHERE id=?").get(id);
    if (!row) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE memories SET content=COALESCE(?,content), updated=?, last_used=?, confidence=COALESCE(?,confidence), chat_id=COALESCE(?,chat_id), category=COALESCE(?,category) WHERE id=?",
      )
      .run(
        meta.content ?? null,
        now,
        now,
        meta.confidence ?? null,
        meta.chatId ?? null,
        meta.category ?? null,
        id,
      );
  }
  forget(id, userId = resolveLocalOwner(this).id) {
    return (
      this.db
        .prepare("DELETE FROM memories WHERE id=? AND user_id=?")
        .run(id, userId).changes > 0
    );
  }
  event(chatId, tool, detail, status) {
    const chatUser = chatId
      ? this.db.prepare("SELECT user_id FROM chats WHERE id=?").get(chatId)
      : null;
    const userId = chatUser?.user_id ?? resolveLocalOwner(this).id;
    this.db
      .prepare(
        "INSERT INTO events(chat_id,tool,detail,status,created,user_id) VALUES(?,?,?,?,?,?)",
      )
      .run(
        chatId ?? null,
        tool,
        JSON.stringify(detail).slice(0, 20000),
        status,
        new Date().toISOString(),
        userId,
      );
  }
  events(userId = resolveLocalOwner(this).id) {
    return this.db
      .prepare(
        `SELECT e.* FROM events e
         LEFT JOIN chats c ON c.id=e.chat_id
         WHERE e.user_id=? OR c.user_id=?
         ORDER BY e.id DESC LIMIT 100`,
      )
      .all(userId, userId);
  }
  close() {
    this.db.close();
  }
  counts(userId) {
    const where = userId === undefined ? "" : " WHERE user_id=?";
    const params = userId === undefined ? [] : [userId];
    return {
      memories: this.db
        .prepare(`SELECT COUNT(*) AS n FROM memories${where}`)
        .get(...params).n,
      conversations: this.db
        .prepare(`SELECT COUNT(*) AS n FROM chats${where}`)
        .get(...params).n,
      completedTools: this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM events WHERE status='done'${userId === undefined ? "" : " AND user_id=?"}`,
        )
        .get(...params).n,
    };
  }
}
