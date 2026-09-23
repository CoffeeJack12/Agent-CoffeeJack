/**
 * Cloudflare Access / external identity mapping.
 * Never trust client-supplied email/userId for authorization.
 */

import { randomUUID } from "node:crypto";
import {
  audit,
  createUser,
  getUser,
  resolveLocalOwner,
} from "./users.mjs";

export const IDENTITY_PROVIDER = "cloudflare_access";

export function ensureIdentitySchema(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS external_identities (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      external_subject TEXT NOT NULL,
      normalized_email TEXT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(provider, external_subject)
    );
    CREATE INDEX IF NOT EXISTS external_identities_email
      ON external_identities(provider, normalized_email);
    CREATE INDEX IF NOT EXISTS external_identities_user
      ON external_identities(user_id);
  `);
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export function findIdentityBySubject(store, provider, subject) {
  if (!subject) return undefined;
  return store.db
    .prepare(
      `SELECT * FROM external_identities
       WHERE provider=? AND external_subject=?`,
    )
    .get(provider, String(subject));
}

export function findIdentitiesForUser(store, userId) {
  return store.db
    .prepare(
      `SELECT id,provider,external_subject,normalized_email,created_at,last_seen_at
       FROM external_identities WHERE user_id=? ORDER BY created_at`,
    )
    .all(userId);
}

export function linkExternalIdentity(
  store,
  {
    provider = IDENTITY_PROVIDER,
    subject,
    email,
    userId,
    actorUserId = null,
  },
) {
  if (!subject || !userId) throw new Error("subject and userId are required");
  const user = getUser(store, userId);
  if (!user || user.status !== "active") throw new Error("User is not active");
  const existing = findIdentityBySubject(store, provider, subject);
  if (existing && existing.user_id !== userId)
    throw new Error("Identity already linked to another user");
  const now = new Date().toISOString();
  const normalized = normalizeEmail(email);
  if (existing) {
    store.db
      .prepare(
        `UPDATE external_identities
         SET normalized_email=?, last_seen_at=? WHERE id=?`,
      )
      .run(normalized || existing.normalized_email, now, existing.id);
    audit(store, {
      userId: actorUserId || userId,
      action: "external_identity_linked",
      detail: {
        provider,
        subject: String(subject).slice(0, 120),
        updated: true,
      },
    });
    return findIdentityBySubject(store, provider, subject);
  }
  const id = randomUUID();
  store.db
    .prepare(
      `INSERT INTO external_identities
       (id,provider,external_subject,normalized_email,user_id,created_at,last_seen_at)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(id, provider, String(subject), normalized || null, userId, now, now);
  audit(store, {
    userId: actorUserId || userId,
    action: "external_identity_linked",
    detail: { provider, subject: String(subject).slice(0, 120) },
  });
  return findIdentityBySubject(store, provider, subject);
}

export function unlinkExternalIdentity(
  store,
  { provider = IDENTITY_PROVIDER, subject, actorUserId },
) {
  const row = findIdentityBySubject(store, provider, subject);
  if (!row) return false;
  store.db
    .prepare(
      `DELETE FROM external_identities WHERE provider=? AND external_subject=?`,
    )
    .run(provider, String(subject));
  audit(store, {
    userId: actorUserId || row.user_id,
    action: "external_identity_unlinked",
    detail: { provider, subject: String(subject).slice(0, 120) },
  });
  return true;
}

export function touchIdentity(store, provider, subject) {
  store.db
    .prepare(
      `UPDATE external_identities SET last_seen_at=?
       WHERE provider=? AND external_subject=?`,
    )
    .run(new Date().toISOString(), provider, String(subject));
}

/**
 * Resolve a verified Access identity to a CoffeeJack user.
 * status: mapped | pending | denied
 */
export function resolveExternalIdentity(store, verified, options = {}) {
  if (!verified?.email && !verified?.subject)
    return { status: "denied", reason: "missing_identity" };
  const provider = IDENTITY_PROVIDER;
  const subject = String(verified.subject || verified.email);
  const email = normalizeEmail(verified.email);
  const mapped = findIdentityBySubject(store, provider, subject);
  if (mapped) {
    const user = getUser(store, mapped.user_id);
    if (!user || user.status !== "active")
      return { status: "denied", reason: "disabled_user" };
    touchIdentity(store, provider, subject);
    return { status: "mapped", user, identity: mapped };
  }

  const ownerEmails = new Set(
    (options.ownerAutoLinkEmails || [])
      .map((e) => normalizeEmail(e))
      .filter(Boolean),
  );
  if (email && ownerEmails.has(email)) {
    const owner = resolveLocalOwner(store);
    const identity = linkExternalIdentity(store, {
      provider,
      subject,
      email,
      userId: owner.id,
      actorUserId: owner.id,
    });
    return { status: "mapped", user: owner, identity };
  }

  if (options.autoCreateRole === "standard" && email) {
    const user = createUser(store, {
      displayName: email.split("@")[0].slice(0, 40) || "Remote User",
      role: "standard",
    });
    const identity = linkExternalIdentity(store, {
      provider,
      subject,
      email,
      userId: user.id,
    });
    return { status: "mapped", user, identity };
  }

  return {
    status: "pending",
    reason: "unmapped_identity",
    email,
    subject,
  };
}
