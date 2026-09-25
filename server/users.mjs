import { randomBytes, randomUUID } from "node:crypto";

export const ROLES = Object.freeze({
  OWNER: "owner",
  TRUSTED: "trusted",
  STANDARD: "standard",
  GUEST: "guest",
});

export const ROLE_LABELS = Object.freeze({
  [ROLES.OWNER]: "Owner",
  [ROLES.TRUSTED]: "Trusted",
  [ROLES.STANDARD]: "Standard",
  [ROLES.GUEST]: "Guest",
});

const ROLE_VALUES = new Set(Object.values(ROLES));

function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((item) => item.name === column);
}

function addColumn(db, table, definition) {
  const [column] = definition.split(/\s+/, 1);
  if (!hasColumn(db, table, column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

/**
 * Upgrade a legacy single-user database in one restart-safe transaction.
 * Existing data always belongs to the local owner.
 */
export function migrateToMultiUser(store) {
  const db = store?.db;
  if (!db) throw new Error("A CoffeeJack store is required");

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created TEXT NOT NULL,
        updated TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        revoked TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL,
        created TEXT NOT NULL
      );
    `);

    addColumn(db, "users", "display_name TEXT");
    addColumn(db, "users", "role TEXT");
    addColumn(db, "users", "status TEXT NOT NULL DEFAULT 'active'");
    addColumn(db, "users", "created TEXT");
    addColumn(db, "users", "updated TEXT");
    addColumn(db, "users", "email TEXT");
    addColumn(db, "users", "email_normalized TEXT");
    addColumn(db, "users", "password_hash TEXT");
    addColumn(db, "users", "email_verified INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "users", "password_set_at TEXT");
    addColumn(db, "sessions", "user_id TEXT REFERENCES users(id)");
    addColumn(db, "sessions", "created TEXT");
    addColumn(db, "sessions", "last_seen TEXT");
    addColumn(db, "sessions", "revoked TEXT");
    addColumn(db, "audit_events", "user_id TEXT REFERENCES users(id)");
    addColumn(db, "audit_events", "action TEXT");
    addColumn(db, "audit_events", "detail TEXT");
    addColumn(db, "audit_events", "created TEXT");

    const now = new Date().toISOString();
    let owner = db
      .prepare("SELECT * FROM users WHERE role=? ORDER BY created LIMIT 1")
      .get(ROLES.OWNER);
    const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
    if (!userCount) {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO users(id,display_name,role,status,created,updated) VALUES(?,?,?,?,?,?)",
      ).run(id, "Abdulrahman", ROLES.OWNER, "active", now, now);
      owner = db.prepare("SELECT * FROM users WHERE id=?").get(id);
    } else if (!owner) {
      // A partially completed/manual migration must still end with one owner.
      const first = db.prepare("SELECT id FROM users ORDER BY created,id LIMIT 1").get();
      db.prepare("UPDATE users SET role=?,updated=? WHERE id=?").run(
        ROLES.OWNER,
        now,
        first.id,
      );
      owner = db.prepare("SELECT * FROM users WHERE id=?").get(first.id);
    }

    for (const table of ["chats", "memories", "events"]) {
      addColumn(db, table, "user_id TEXT REFERENCES users(id)");
      db.prepare(`UPDATE ${table} SET user_id=? WHERE user_id IS NULL`).run(
        owner.id,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS ${table}_user_id ON ${table}(user_id)`,
      );
    }

    const legacyPreferences = db
      .prepare("SELECT value FROM profile_preferences WHERE profile_id='owner'")
      .get();
    if (legacyPreferences) {
      db.prepare(
        "INSERT OR IGNORE INTO profile_preferences(profile_id,value) VALUES(?,?)",
      ).run(owner.id, legacyPreferences.value);
    }

    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").run(
      "multiuser_v1",
      JSON.stringify(true),
    );
    db.exec("COMMIT");
    return owner;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the migration error.
    }
    throw error;
  }
}

export const ensureMultiUserSchema = migrateToMultiUser;

function cleanDisplayName(displayName) {
  if (
    typeof displayName !== "string" ||
    !displayName.trim() ||
    displayName.trim().length > 80 ||
    /[\r\n<>]/.test(displayName)
  )
    throw new Error("Invalid display name");
  return displayName.trim();
}

function cleanRole(role) {
  const value = String(role ?? "").toLowerCase();
  if (!ROLE_VALUES.has(value)) throw new Error("Invalid user role");
  return value;
}

export function createUser(store, { displayName, role = ROLES.STANDARD }) {
  const now = new Date().toISOString();
  const user = {
    id: randomUUID(),
    display_name: cleanDisplayName(displayName),
    role: cleanRole(role),
    status: "active",
    created: now,
    updated: now,
  };
  store.db
    .prepare(
      "INSERT INTO users(id,display_name,role,status,created,updated) VALUES(?,?,?,?,?,?)",
    )
    .run(
      user.id,
      user.display_name,
      user.role,
      user.status,
      user.created,
      user.updated,
    );
  return user;
}

export function listUsers(store) {
  return store.db
    .prepare(
      "SELECT id,display_name,role,status,created,updated,email,email_verified FROM users ORDER BY created,id",
    )
    .all();
}

export function getUser(store, id) {
  if (!id) return undefined;
  return store.db
    .prepare(
      "SELECT id,display_name,role,status,created,updated,email,email_verified FROM users WHERE id=?",
    )
    .get(id);
}

export function updateUser(store, id, changes = {}) {
  const current = getUser(store, id);
  if (!current) return undefined;
  const displayName =
    changes.displayName === undefined
      ? current.display_name
      : cleanDisplayName(changes.displayName);
  const role =
    changes.role === undefined ? current.role : cleanRole(changes.role);
  const status =
    changes.status === undefined ? current.status : String(changes.status);
  if (!["active", "disabled"].includes(status))
    throw new Error("Invalid user status");
  const updated = new Date().toISOString();
  store.db
    .prepare(
      "UPDATE users SET display_name=?,role=?,status=?,updated=? WHERE id=?",
    )
    .run(displayName, role, status, updated, id);
  return getUser(store, id);
}

export function disableUser(store, id) {
  const user = updateUser(store, id, { status: "disabled" });
  if (user)
    store.db
      .prepare("UPDATE sessions SET revoked=? WHERE user_id=? AND revoked IS NULL")
      .run(new Date().toISOString(), id);
  return user;
}

export function createSession(store, userId, { source = "local", ttlMs } = {}) {
  const user = getUser(store, userId);
  if (!user || user.status !== "active") throw new Error("User is not active");
  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  const ttl =
    ttlMs ??
    (source === "remote" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000);
  const expires = new Date(Date.now() + ttl).toISOString();
  // Soft-migrate session columns.
  try {
    const cols = store.db.prepare("PRAGMA table_info(sessions)").all();
    if (!cols.some((c) => c.name === "expires_at"))
      store.db.exec("ALTER TABLE sessions ADD COLUMN expires_at TEXT");
    if (!cols.some((c) => c.name === "source"))
      store.db.exec("ALTER TABLE sessions ADD COLUMN source TEXT");
  } catch {
    /* ignore */
  }
  store.db
    .prepare(
      "INSERT INTO sessions(token,user_id,created,last_seen,revoked,expires_at,source) VALUES(?,?,?,?,NULL,?,?)",
    )
    .run(token, user.id, now, now, expires, source);
  return {
    token,
    userId: user.id,
    created: now,
    lastSeen: now,
    expiresAt: expires,
    source,
  };
}

export function getSession(store, token) {
  if (typeof token !== "string" || !token) return undefined;
  try {
    const cols = store.db.prepare("PRAGMA table_info(sessions)").all();
    if (!cols.some((c) => c.name === "expires_at"))
      store.db.exec("ALTER TABLE sessions ADD COLUMN expires_at TEXT");
    if (!cols.some((c) => c.name === "source"))
      store.db.exec("ALTER TABLE sessions ADD COLUMN source TEXT");
  } catch {
    /* ignore */
  }
  const row = store.db
    .prepare(
      `SELECT s.token,s.user_id,s.created,s.last_seen,s.expires_at,s.source,
              u.display_name,u.role,u.status
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token=? AND s.revoked IS NULL AND u.status='active'`,
    )
    .get(token);
  if (!row) return undefined;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    revokeSession(store, token);
    return undefined;
  }
  return row;
}

export function touchSession(store, token) {
  const now = new Date().toISOString();
  const result = store.db
    .prepare("UPDATE sessions SET last_seen=? WHERE token=? AND revoked IS NULL")
    .run(now, token);
  return result.changes > 0;
}

export function revokeSession(store, token) {
  const result = store.db
    .prepare("UPDATE sessions SET revoked=? WHERE token=? AND revoked IS NULL")
    .run(new Date().toISOString(), token);
  return result.changes > 0;
}

function safeAuditDetail(detail) {
  const redact = (value, key = "") => {
    if (/content|message|body|password|secret|token|credential|api.?key/i.test(key))
      return "[redacted]";
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 40)
          .map(([name, item]) => [name, redact(item, name)]),
      );
    if (typeof value === "string") return value.slice(0, 500);
    return value;
  };
  return JSON.stringify(redact(detail ?? {}))
    .replace(
      /(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{12,}|github_pat_[a-zA-Z0-9_]{12,}|Bearer\s+[\w.~-]{12,})/gi,
      "[redacted]",
    )
    .replace(
      /((?:password|passwd|secret|api[_ -]?key|access[_ -]?token)\s*[:=]\s*)[^"',}\s]+/gi,
      "$1[redacted]",
    )
    .slice(0, 4000);
}

export function audit(store, { userId = null, action, detail = {} }) {
  if (typeof action !== "string" || !action.trim() || action.length > 120)
    throw new Error("Invalid audit action");
  const result = store.db
    .prepare(
      "INSERT INTO audit_events(user_id,action,detail,created) VALUES(?,?,?,?)",
    )
    .run(
      userId,
      action.trim(),
      safeAuditDetail(detail),
      new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}

/** Resolve identity from local server state, never from a client-supplied id. */
export function resolveLocalOwner(store) {
  const owner = store.db
    .prepare(
      "SELECT id,display_name,role,status,created,updated,email,email_verified FROM users WHERE role='owner' AND status='active' ORDER BY created,id LIMIT 1",
    )
    .get();
  if (!owner) throw new Error("No active local owner exists");
  return owner;
}
