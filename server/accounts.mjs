/**
 * CoffeeJack-native accounts (email + password).
 * Presentation/persona is separate. Client-supplied role is ignored on signup.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  hashPassword,
  looksLikePasswordHash,
  validatePasswordPolicy,
  verifyPassword,
  verifyPasswordDummy,
} from "./password.mjs";
import { buildAuthEmail, deliverAuthMessage, mailStatus } from "./email.mjs";
import { ROLES, audit, createUser } from "./users.mjs";
import { ensureUserWorkspace } from "./workspaces.mjs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email) {
  const value = String(email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(value) || value.length > 190)
    throw new Error("Invalid email");
  return value;
}

function tokenHash(raw) {
  return createHash("sha256").update(String(raw)).digest("hex");
}

export function ensureAuthSchema(store) {
  const db = store.db;
  const cols = db.prepare("PRAGMA table_info(users)").all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("email")) db.exec("ALTER TABLE users ADD COLUMN email TEXT");
  if (!names.has("email_normalized"))
    db.exec("ALTER TABLE users ADD COLUMN email_normalized TEXT");
  if (!names.has("password_hash"))
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
  if (!names.has("email_verified"))
    db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  if (!names.has("password_set_at"))
    db.exec("ALTER TABLE users ADD COLUMN password_set_at TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized
      ON users(email_normalized) WHERE email_normalized IS NOT NULL;
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_tokens_hash ON auth_tokens(token_hash);
  `);
}

export async function backupSqliteOnce(dataDirectory) {
  if (!dataDirectory) return null;
  const dbPath = path.join(dataDirectory, "coffeejack.sqlite");
  const destDir = path.join(dataDirectory, "backups");
  const marker = path.join(destDir, "auth-schema-backup.done");
  try {
    await fs.access(dbPath);
    await fs.access(marker);
    return null;
  } catch {
    /* continue */
  }
  try {
    await fs.mkdir(destDir, { recursive: true });
    const dest = path.join(
      destDir,
      `coffeejack-pre-auth-${new Date().toISOString().replace(/[:.]/g, "")}.sqlite`,
    );
    await fs.copyFile(dbPath, dest);
    await fs.writeFile(marker, dest);
    return dest;
  } catch {
    return null;
  }
}

export function getUserByEmail(store, email) {
  try {
    const normalized = normalizeEmail(email);
    return store.db
      .prepare(
        `SELECT id,display_name,role,status,created,updated,email,email_normalized,
                email_verified,password_hash,password_set_at
         FROM users WHERE email_normalized=?`,
      )
      .get(normalized);
  } catch {
    return undefined;
  }
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    email: user.email || null,
    email_verified: Boolean(user.email_verified),
  };
}

function issueToken(store, { userId, purpose, ttlMs }) {
  const raw = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + ttlMs).toISOString();
  store.db
    .prepare(
      "INSERT INTO auth_tokens(id,user_id,purpose,token_hash,expires_at,used_at,created) VALUES(?,?,?,?,?,NULL,?)",
    )
    .run(cryptoRandomId(), userId, purpose, tokenHash(raw), expires, now);
  return { raw, expires };
}

function cryptoRandomId() {
  return randomBytes(16).toString("hex");
}

function consumeToken(store, { raw, purpose }) {
  if (typeof raw !== "string" || raw.length < 20) return null;
  const row = store.db
    .prepare(
      `SELECT * FROM auth_tokens WHERE token_hash=? AND purpose=?`,
    )
    .get(tokenHash(raw), purpose);
  if (!row) return null;
  if (row.used_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  store.db
    .prepare("UPDATE auth_tokens SET used_at=? WHERE id=? AND used_at IS NULL")
    .run(new Date().toISOString(), row.id);
  return row;
}

export async function registerAccount(
  store,
  { displayName, email, password, confirmPassword, role: _ignored },
  { dataDirectory, mail, publicBase },
) {
  ensureAuthSchema(store);
  if (password !== confirmPassword)
    throw new Error("Passwords do not match");
  const policy = validatePasswordPolicy(password);
  if (!policy.ok) throw new Error(policy.error);
  const normalized = normalizeEmail(email);
  if (getUserByEmail(store, normalized))
    throw new Error("An account with this email already exists");
  const created = createUser(store, {
    displayName,
    role: ROLES.STANDARD,
  });
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  store.db
    .prepare(
      `UPDATE users SET email=?,email_normalized=?,password_hash=?,email_verified=0,password_set_at=?,updated=? WHERE id=?`,
    )
    .run(normalized, normalized, passwordHash, now, now, created.id);
  if (dataDirectory)
    await ensureUserWorkspace(store, created.id, dataDirectory);
  const token = issueToken(store, {
    userId: created.id,
    purpose: "verify",
    ttlMs: 24 * 60 * 60 * 1000,
  });
  const delivered = await deliverAuthMessage(
    dataDirectory,
    {
      to: normalized,
      subject: "Verify your CoffeeJack account",
      text: buildAuthEmail({
        purpose: "verify",
        rawToken: token.raw,
        publicBase,
        expiresHours: 24,
      }),
      purpose: "verify",
      rawToken: token.raw,
      publicBase,
      expiresHours: 24,
    },
    mail,
  );
  audit(store, {
    userId: created.id,
    action: "account_registered",
    detail: { email: normalized, role: ROLES.STANDARD },
  });
  return {
    user: publicUser(getUserByEmail(store, normalized)),
    mail: {
      configured: delivered.configured,
      mode: delivered.mode,
      message: delivered.message,
      delivered: Boolean(delivered.record?.delivered),
    },
    devToken: delivered.record?.devStored ? token.raw : undefined,
  };
}

export async function authenticateAccount(store, { email, password }) {
  ensureAuthSchema(store);
  let user;
  try {
    user = getUserByEmail(store, email);
  } catch {
    user = undefined;
  }
  if (!user?.password_hash) {
    await verifyPasswordDummy(password);
    return { ok: false };
  }
  if (user.status !== "active") {
    await verifyPasswordDummy(password);
    return { ok: false };
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return { ok: false };
  return { ok: true, user };
}

export async function verifyEmail(store, rawToken) {
  ensureAuthSchema(store);
  const row = consumeToken(store, { raw: rawToken, purpose: "verify" });
  if (!row) throw new Error("Invalid or expired verification token");
  store.db
    .prepare("UPDATE users SET email_verified=1,updated=? WHERE id=?")
    .run(new Date().toISOString(), row.user_id);
  audit(store, {
    userId: row.user_id,
    action: "email_verified",
    detail: {},
  });
  const user = store.db.prepare("SELECT * FROM users WHERE id=?").get(row.user_id);
  return publicUser(user);
}

export async function resendVerification(
  store,
  user,
  { dataDirectory, mail, publicBase },
) {
  ensureAuthSchema(store);
  if (!user?.email) throw new Error("No email on this account");
  if (user.email_verified)
    return {
      alreadyVerified: true,
      user: publicUser(user),
      mail: mailStatus(mail?.env),
    };
  const now = new Date().toISOString();
  store.db
    .prepare(
      "UPDATE auth_tokens SET used_at=? WHERE user_id=? AND purpose='verify' AND used_at IS NULL",
    )
    .run(now, user.id);
  const token = issueToken(store, {
    userId: user.id,
    purpose: "verify",
    ttlMs: 24 * 60 * 60 * 1000,
  });
  const delivered = await deliverAuthMessage(
    dataDirectory,
    {
      to: user.email_normalized || user.email,
      subject: "Verify your CoffeeJack account",
      text: buildAuthEmail({
        purpose: "verify",
        rawToken: token.raw,
        publicBase,
        expiresHours: 24,
      }),
      purpose: "verify",
      rawToken: token.raw,
      publicBase,
      expiresHours: 24,
    },
    mail,
  );
  audit(store, {
    userId: user.id,
    action: "verification_resent",
    detail: { email: user.email_normalized || user.email },
  });
  return {
    alreadyVerified: false,
    mail: {
      configured: delivered.configured,
      mode: delivered.mode,
      message: delivered.message,
      delivered: Boolean(delivered.record?.delivered),
    },
    devToken: delivered.record?.devStored ? token.raw : undefined,
  };
}

export async function requestPasswordReset(
  store,
  email,
  { dataDirectory, mail, publicBase },
) {
  ensureAuthSchema(store);
  const status = mailStatus(mail?.env);
  const honest = !status.configured
    ? status.message
    : "If an account exists, reset instructions have been sent.";
  const neutral = { message: honest, mail: status };
  let user;
  try {
    user = getUserByEmail(store, email);
  } catch {
    user = undefined;
  }
  if (!user?.password_hash) return { ...neutral, issued: false };
  const token = issueToken(store, {
    userId: user.id,
    purpose: "reset",
    ttlMs: 60 * 60 * 1000,
  });
  const delivered = await deliverAuthMessage(
    dataDirectory,
    {
      to: user.email_normalized,
      subject: "Reset your CoffeeJack password",
      text: buildAuthEmail({
        purpose: "reset",
        rawToken: token.raw,
        publicBase,
        expiresHours: 1,
      }),
      purpose: "reset",
      rawToken: token.raw,
      publicBase,
      expiresHours: 1,
    },
    mail,
  );
  audit(store, {
    userId: user.id,
    action: "password_reset_requested",
    detail: { email: user.email_normalized },
  });
  return {
    message: honest,
    issued: true,
    mail: {
      configured: delivered.configured,
      mode: delivered.mode,
      message: delivered.message,
    },
    devToken: delivered.record?.devStored ? token.raw : undefined,
  };
}

export async function resetPassword(store, { token, password, confirmPassword }) {
  ensureAuthSchema(store);
  if (password !== confirmPassword) throw new Error("Passwords do not match");
  const policy = validatePasswordPolicy(password);
  if (!policy.ok) throw new Error(policy.error);
  const row = consumeToken(store, { raw: token, purpose: "reset" });
  if (!row) throw new Error("Invalid or expired reset token");
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  store.db
    .prepare(
      "UPDATE users SET password_hash=?,password_set_at=?,updated=? WHERE id=?",
    )
    .run(passwordHash, now, now, row.user_id);
  const revoked = revokeSessionsForUser(store, row.user_id);
  audit(store, {
    userId: row.user_id,
    action: "password_reset",
    detail: { sessionsRevoked: revoked },
  });
  return { userId: row.user_id, sessionsRevoked: revoked };
}

export async function attachOwnerCredentials(
  store,
  owner,
  { email, password, confirmPassword },
) {
  ensureAuthSchema(store);
  if (!owner || owner.role !== ROLES.OWNER)
    throw new Error("Only the Owner can attach Owner credentials");
  if (password !== confirmPassword) throw new Error("Passwords do not match");
  const normalized = normalizeEmail(email);
  const existing = getUserByEmail(store, normalized);
  if (existing && existing.id !== owner.id)
    throw new Error("That email is already used");
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  store.db
    .prepare(
      `UPDATE users SET email=?,email_normalized=?,password_hash=?,email_verified=1,password_set_at=?,updated=? WHERE id=?`,
    )
    .run(normalized, normalized, passwordHash, now, now, owner.id);
  audit(store, {
    userId: owner.id,
    action: "owner_credentials_set",
    detail: { email: normalized },
  });
  return publicUser(getUserByEmail(store, normalized));
}

export function revokeSessionsForUser(store, userId) {
  const result = store.db
    .prepare(
      "UPDATE sessions SET revoked=? WHERE user_id=? AND revoked IS NULL",
    )
    .run(new Date().toISOString(), userId);
  return result.changes;
}

export function passwordHashPresent(store, userId) {
  const row = store.db
    .prepare("SELECT password_hash FROM users WHERE id=?")
    .get(userId);
  return looksLikePasswordHash(row?.password_hash);
}

export { looksLikePasswordHash };
