import {
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { ROLES, createUser } from "./users.mjs";

// Self-service account layer (email + password) that sits on top of the
// existing multi-user users/sessions tables. New signups are always the
// least-privileged "standard" role and start unverified.

const VERIFY_TTL_MINUTES = 15;
const RESET_TTL_MINUTES = 30;
const MAX_CODE_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((item) => item.name === column);
}

/** Add the account columns and code table. Safe to run on every boot. */
export function ensureAuthSchema(store) {
  const db = store?.db;
  if (!db) throw new Error("A CoffeeJack store is required");
  for (const definition of [
    "email TEXT",
    "email_normalized TEXT",
    "password_hash TEXT",
    "email_verified INTEGER NOT NULL DEFAULT 0",
  ]) {
    const [column] = definition.split(/\s+/, 1);
    if (!hasColumn(db, "users", column))
      db.exec(`ALTER TABLE users ADD COLUMN ${definition}`);
  }
  // Partial unique index leaves legacy profiles (NULL email) untouched.
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized ON users(email_normalized) WHERE email_normalized IS NOT NULL",
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires TEXT NOT NULL,
      created TEXT NOT NULL,
      consumed TEXT,
      attempts INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS auth_codes_user ON auth_codes(user_id, purpose)",
  );
}

export function normalizeEmail(email) {
  if (typeof email !== "string") throw new Error("Email is required");
  const value = email.trim();
  if (!value || value.length > 254 || !EMAIL_RE.test(value))
    throw new Error("Enter a valid email address");
  return value.toLowerCase();
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8)
    throw new Error("Password must be at least 8 characters");
  if (password.length > 200) throw new Error("Password is too long");
  return password;
}

// scrypt keeps password material non-reversible; format is scheme$salt$hash.
export function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export function verifyPassword(stored, password) {
  try {
    const [scheme, saltB64, hashB64] = String(stored).split("$");
    if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, "base64");
    const derived = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length);
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

// A per-install secret so a stolen database cannot brute-force short codes offline.
function codeSecret(store) {
  let secret = store.get("auth_code_secret", null);
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    store.set("auth_code_secret", secret);
  }
  return secret;
}

function hashCode(store, purpose, code) {
  return createHmac("sha256", codeSecret(store))
    .update(`${purpose}:${code}`)
    .digest("hex");
}

function displayNameFromEmail(email) {
  const local = email.split("@")[0].replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 80);
  return local || "Member";
}

export function findUserByEmail(store, email) {
  let normalized;
  try {
    normalized = normalizeEmail(email);
  } catch {
    return undefined;
  }
  return store.db
    .prepare(
      "SELECT id,display_name,role,status,email,email_verified,created,updated FROM users WHERE email_normalized=?",
    )
    .get(normalized);
}

export function getAuthUser(store, id) {
  if (!id) return undefined;
  return store.db
    .prepare(
      "SELECT id,display_name,role,status,email,email_verified,created,updated FROM users WHERE id=?",
    )
    .get(id);
}

/** Create a standard, unverified account. Throws on invalid or duplicate email. */
export function signup(store, { email, password }) {
  const normalized = normalizeEmail(email);
  validatePassword(password);
  if (findUserByEmail(store, normalized))
    throw new Error("Email already registered");
  const displayEmail = email.trim();
  const user = createUser(store, {
    displayName: displayNameFromEmail(displayEmail),
    role: ROLES.STANDARD,
  });
  store.db
    .prepare(
      "UPDATE users SET email=?, email_normalized=?, password_hash=?, email_verified=0, updated=? WHERE id=?",
    )
    .run(displayEmail, normalized, hashPassword(password), new Date().toISOString(), user.id);
  return getAuthUser(store, user.id);
}

export function authenticate(store, { email, password }) {
  const user = findUserByEmail(store, email);
  if (!user) return null;
  const row = store.db
    .prepare("SELECT password_hash FROM users WHERE id=?")
    .get(user.id);
  if (!row?.password_hash || !verifyPassword(row.password_hash, password))
    return null;
  return user;
}

export function setPassword(store, userId, password) {
  validatePassword(password);
  store.db
    .prepare("UPDATE users SET password_hash=?, updated=? WHERE id=?")
    .run(hashPassword(password), new Date().toISOString(), userId);
}

export function markEmailVerified(store, userId) {
  store.db
    .prepare("UPDATE users SET email_verified=1, updated=? WHERE id=?")
    .run(new Date().toISOString(), userId);
}

/**
 * Issue a fresh single-use code, invalidating earlier ones for the same
 * purpose. Returns the plaintext code to the caller for emailing only; it is
 * never persisted or logged in the clear.
 */
export function issueCode(store, userId, purpose = "verify", ttlMinutes) {
  const minutes =
    ttlMinutes ?? (purpose === "reset" ? RESET_TTL_MINUTES : VERIFY_TTL_MINUTES);
  const now = new Date();
  store.db
    .prepare(
      "UPDATE auth_codes SET consumed=? WHERE user_id=? AND purpose=? AND consumed IS NULL",
    )
    .run(now.toISOString(), userId, purpose);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expires = new Date(now.getTime() + minutes * 60_000).toISOString();
  store.db
    .prepare(
      "INSERT INTO auth_codes(user_id,purpose,code_hash,expires,created,attempts) VALUES(?,?,?,?,?,0)",
    )
    .run(userId, purpose, hashCode(store, purpose, code), expires, now.toISOString());
  return { code, expiresAt: expires, expiresMinutes: minutes };
}

/**
 * Validate a submitted code for a user+purpose. Consumes the code on success,
 * counts attempts and burns the code after too many failures.
 */
export function verifyCode(store, userId, purpose, code) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code.trim()))
    return { ok: false, reason: "invalid" };
  const row = store.db
    .prepare(
      "SELECT id,code_hash,expires,attempts FROM auth_codes WHERE user_id=? AND purpose=? AND consumed IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get(userId, purpose);
  if (!row) return { ok: false, reason: "invalid" };
  if (Date.parse(row.expires) <= Date.now()) {
    store.db
      .prepare("UPDATE auth_codes SET consumed=? WHERE id=?")
      .run(new Date().toISOString(), row.id);
    return { ok: false, reason: "expired" };
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    store.db
      .prepare("UPDATE auth_codes SET consumed=? WHERE id=?")
      .run(new Date().toISOString(), row.id);
    return { ok: false, reason: "too_many" };
  }
  const submitted = Buffer.from(hashCode(store, purpose, code.trim()), "hex");
  const expected = Buffer.from(row.code_hash, "hex");
  const match =
    submitted.length === expected.length && timingSafeEqual(submitted, expected);
  if (!match) {
    store.db
      .prepare("UPDATE auth_codes SET attempts=attempts+1 WHERE id=?")
      .run(row.id);
    return { ok: false, reason: "invalid" };
  }
  store.db
    .prepare("UPDATE auth_codes SET consumed=? WHERE id=?")
    .run(new Date().toISOString(), row.id);
  return { ok: true };
}
