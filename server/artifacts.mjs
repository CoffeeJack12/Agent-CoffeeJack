/**
 * Per-user / per-workspace artifact storage with path confinement.
 * Public URLs remain /artifacts/<safe-name>; authorization is server-side only.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { audit, resolveLocalOwner } from "./users.mjs";
import { userCanAccessWorkspace } from "./workspaces.mjs";

const SAFE_NAME = /^[a-z]+-\d+\.png$/i;

export function ensureArtifactSchema(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      chat_id TEXT,
      relative_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS artifacts_user ON artifacts(user_id);
    CREATE INDEX IF NOT EXISTS artifacts_workspace ON artifacts(workspace_id);
  `);
}

export function isSafeArtifactName(name) {
  return typeof name === "string" && SAFE_NAME.test(name) && !name.includes("..");
}

export function artifactRelativePath(userId, workspaceId, name) {
  if (!userId || !workspaceId || !isSafeArtifactName(name))
    throw new Error("Invalid artifact coordinates");
  return path.join(userId, workspaceId, name);
}

export async function ensureScopedArtifactDir(base, userId, workspaceId) {
  const root = await fs.realpath(base);
  const target = path.resolve(root, userId, workspaceId);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("Artifact path escapes storage root");
  await fs.mkdir(target, { recursive: true });
  const real = await fs.realpath(target);
  const r = path.relative(root, real);
  if (r.startsWith("..") || path.isAbsolute(r))
    throw new Error("Artifact directory escapes storage root");
  return real;
}

/**
 * Resolve an on-disk path for a registered artifact; never trusts client paths.
 */
export async function resolveArtifactAbsolute(base, row) {
  if (!row?.relative_path || !row?.name) throw new Error("Artifact not found");
  if (!isSafeArtifactName(row.name)) throw new Error("Invalid artifact name");
  const root = await fs.realpath(base);
  const target = path.resolve(root, row.relative_path);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("Artifact path escapes storage root");
  if (path.basename(target).toLowerCase() !== row.name.toLowerCase())
    throw new Error("Artifact name mismatch");
  try {
    const real = await fs.realpath(target);
    const r = path.relative(root, real);
    if (r.startsWith("..") || path.isAbsolute(r))
      throw new Error("Artifact link escapes storage root");
    return real;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Artifact file missing");
    throw error;
  }
}

export function getArtifactByName(store, name) {
  if (!isSafeArtifactName(name)) return undefined;
  return store.db.prepare("SELECT * FROM artifacts WHERE name=?").get(name);
}

export function getArtifactById(store, id) {
  if (!id) return undefined;
  return store.db.prepare("SELECT * FROM artifacts WHERE id=?").get(id);
}

export function registerArtifact(
  store,
  { name, userId, workspaceId, chatId = null, relativePath },
) {
  if (!isSafeArtifactName(name)) throw new Error("Invalid artifact name");
  if (!userId || !workspaceId) throw new Error("Artifact ownership required");
  const rel = relativePath || artifactRelativePath(userId, workspaceId, name);
  const id = randomUUID();
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO artifacts(id,name,user_id,workspace_id,chat_id,relative_path,created_at)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(id, name, userId, workspaceId, chatId || null, rel, now);
  return getArtifactByName(store, name);
}

/**
 * Owner-only: claim a single legacy flat file at <base>/<name> into the registry.
 * Idempotent; never claims for non-owners (prevents guessing another user's file).
 */
export async function claimLegacyFlatArtifact(
  store,
  base,
  { name, actorUserId },
) {
  if (!isSafeArtifactName(name) || !actorUserId) return null;
  const existing = getArtifactByName(store, name);
  if (existing) return existing;
  const owner = resolveLocalOwner(store);
  if (actorUserId !== owner.id) return null;
  const flat = path.join(base, name);
  try {
    const st = await fs.lstat(flat);
    if (!st.isFile() || st.isSymbolicLink?.()) return null;
  } catch {
    return null;
  }
  const ownerWs = store.db
    .prepare(
      `SELECT w.* FROM workspaces w
       JOIN workspace_memberships m ON m.workspace_id=w.id
       WHERE m.user_id=? AND w.owner_user_id=? AND w.status='active'
       ORDER BY w.created_at LIMIT 1`,
    )
    .get(owner.id, owner.id);
  if (!ownerWs) return null;
  const destDir = await ensureScopedArtifactDir(base, owner.id, ownerWs.id);
  const dest = path.join(destDir, name);
  try {
    await fs.rename(flat, dest);
  } catch {
    try {
      await fs.copyFile(flat, dest);
      await fs.unlink(flat);
    } catch {
      return null;
    }
  }
  return registerArtifact(store, {
    name,
    userId: owner.id,
    workspaceId: ownerWs.id,
    relativePath: artifactRelativePath(owner.id, ownerWs.id, name),
  });
}

/**
 * Authorize and resolve file for GET /artifacts/<name>.
 * Never trusts client-supplied userId/workspaceId for path resolution.
 */
export async function authorizeArtifactRead(store, base, { name, userId }) {
  if (!userId)
    throw Object.assign(new Error("Invalid session token"), { status: 403 });
  if (!isSafeArtifactName(name))
    throw Object.assign(new Error("Not found"), { status: 404 });
  let row = getArtifactByName(store, name);
  if (!row)
    row = await claimLegacyFlatArtifact(store, base, {
      name,
      actorUserId: userId,
    });
  if (!row) throw Object.assign(new Error("Not found"), { status: 404 });
  if (!userCanAccessWorkspace(store, userId, row.workspace_id)) {
    audit(store, {
      userId,
      action: "workspace_access_denied",
      detail: { workspaceId: row.workspace_id, artifact: name.slice(0, 40) },
    });
    throw Object.assign(new Error("Artifact access denied"), { status: 403 });
  }
  const absolute = await resolveArtifactAbsolute(base, row);
  return { row, absolute };
}

/**
 * Delete artifacts owned by actor only (never another user's files).
 */
export async function cleanupArtifacts(
  store,
  base,
  { actorUserId, workspaceId = null, olderThanMs = null, names = null },
) {
  if (!actorUserId) throw new Error("actorUserId required");
  let rows;
  if (Array.isArray(names) && names.length) {
    rows = names
      .map((n) => getArtifactByName(store, n))
      .filter((r) => r && r.user_id === actorUserId);
  } else {
    let sql = "SELECT * FROM artifacts WHERE user_id=?";
    const params = [actorUserId];
    if (workspaceId) {
      sql += " AND workspace_id=?";
      params.push(workspaceId);
    }
    rows = store.db.prepare(sql).all(...params);
  }
  const cutoff =
    olderThanMs != null ? Date.now() - Number(olderThanMs) : null;
  let removed = 0;
  for (const row of rows) {
    if (row.user_id !== actorUserId) continue;
    if (cutoff != null && Date.parse(row.created_at) > cutoff) continue;
    try {
      const absolute = await resolveArtifactAbsolute(base, row);
      await fs.unlink(absolute);
    } catch {
      /* missing file still drops DB row for owned artifacts */
    }
    store.db.prepare("DELETE FROM artifacts WHERE id=? AND user_id=?").run(
      row.id,
      actorUserId,
    );
    removed += 1;
  }
  if (removed)
    audit(store, {
      userId: actorUserId,
      action: "artifacts_cleaned",
      detail: { removed, workspaceId: workspaceId || null },
    });
  return { removed };
}

/**
 * Idempotent: claim flat legacy files under artifacts/*.png as owner workspace.
 */
export async function migrateLegacyArtifacts(store, base, { root } = {}) {
  ensureArtifactSchema(store);
  const owner = resolveLocalOwner(store);
  let ownerWs = store.db
    .prepare(
      `SELECT w.* FROM workspaces w
       JOIN workspace_memberships m ON m.workspace_id=w.id
       WHERE m.user_id=? AND w.owner_user_id=? AND w.status='active'
       ORDER BY w.created_at LIMIT 1`,
    )
    .get(owner.id, owner.id);
  if (!ownerWs && root) {
    // Workspace module may not have run yet in unit tests.
    return { migrated: 0 };
  }
  if (!ownerWs) return { migrated: 0 };

  await fs.mkdir(base, { recursive: true });
  let entries = [];
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return { migrated: 0 };
  }
  let migrated = 0;
  const destDir = await ensureScopedArtifactDir(base, owner.id, ownerWs.id);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!isSafeArtifactName(name)) continue;
    if (getArtifactByName(store, name)) continue;
    const src = path.join(base, name);
    const dest = path.join(destDir, name);
    try {
      await fs.rename(src, dest);
    } catch {
      try {
        await fs.copyFile(src, dest);
        await fs.unlink(src);
      } catch {
        continue;
      }
    }
    registerArtifact(store, {
      name,
      userId: owner.id,
      workspaceId: ownerWs.id,
      relativePath: artifactRelativePath(owner.id, ownerWs.id, name),
    });
    migrated += 1;
  }
  if (migrated)
    audit(store, {
      userId: owner.id,
      action: "artifacts_migrated",
      detail: { migrated },
    });
  return { migrated };
}
