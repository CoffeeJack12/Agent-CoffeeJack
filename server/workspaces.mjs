/**
 * Per-user workspaces — ownership, membership, path confinement helpers.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { audit, getUser, resolveLocalOwner } from "./users.mjs";

export function ensureWorkspaceSchema(store) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_memberships (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'owner',
      PRIMARY KEY (workspace_id, user_id)
    );
  `);
  // chat → workspace binding
  const cols = db.prepare("PRAGMA table_info(chats)").all();
  if (!cols.some((c) => c.name === "workspace_id"))
    db.exec("ALTER TABLE chats ADD COLUMN workspace_id TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS chats_workspace_id ON chats(workspace_id)",
  );
}

export function listWorkspacesForUser(store, userId) {
  return store.db
    .prepare(
      `SELECT w.* FROM workspaces w
       JOIN workspace_memberships m ON m.workspace_id=w.id
       WHERE m.user_id=? AND w.status='active'
       ORDER BY w.created_at, w.name`,
    )
    .all(userId);
}

export function getWorkspace(store, id) {
  if (!id) return undefined;
  return store.db.prepare("SELECT * FROM workspaces WHERE id=?").get(id);
}

export function userCanAccessWorkspace(store, userId, workspaceId) {
  if (!userId || !workspaceId) return false;
  const row = store.db
    .prepare(
      `SELECT 1 AS ok FROM workspace_memberships
       WHERE workspace_id=? AND user_id=?`,
    )
    .get(workspaceId, userId);
  return Boolean(row);
}

export async function createWorkspace(
  store,
  { ownerUserId, name, rootPath, actorUserId = null },
) {
  const owner = getUser(store, ownerUserId);
  if (!owner || owner.status !== "active") throw new Error("Owner invalid");
  const resolved = path.resolve(rootPath);
  await fs.mkdir(resolved, { recursive: true });
  const now = new Date().toISOString();
  const id = randomUUID();
  store.db
    .prepare(
      `INSERT INTO workspaces(id,owner_user_id,name,root_path,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(id, ownerUserId, String(name).slice(0, 80), resolved, "active", now, now);
  store.db
    .prepare(
      `INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES(?,?,?)`,
    )
    .run(id, ownerUserId, "owner");
  audit(store, {
    userId: actorUserId || ownerUserId,
    action: "workspace_created",
    detail: { workspaceId: id, name: String(name).slice(0, 80) },
  });
  return getWorkspace(store, id);
}

export function addWorkspaceMember(
  store,
  { workspaceId, userId, role = "member", actorUserId },
) {
  if (!userCanAccessWorkspace(store, actorUserId, workspaceId)) {
    const actor = getUser(store, actorUserId);
    if (actor?.role !== "owner")
      throw new Error("Workspace membership change denied");
  }
  store.db
    .prepare(
      `INSERT OR REPLACE INTO workspace_memberships(workspace_id,user_id,role)
       VALUES(?,?,?)`,
    )
    .run(workspaceId, userId, role);
  audit(store, {
    userId: actorUserId,
    action: "workspace_membership_changed",
    detail: { workspaceId, userId, role },
  });
}

/**
 * Idempotent owner workspace: preserve existing repo / settings.workspace path.
 * Production (data under repo/.local) keeps the CoffeeJack repo root.
 * Isolated data directories (tests) use <data>/projects so the real repo is untouched.
 */
export async function ensureOwnerWorkspace(store, { root, dataDirectory }) {
  const owner = resolveLocalOwner(store);
  const existing = listWorkspacesForUser(store, owner.id).find(
    (w) => w.owner_user_id === owner.id,
  );
  if (existing) return existing;

  const underRepoLocal =
    dataDirectory &&
    root &&
    path.resolve(dataDirectory) === path.resolve(path.join(root, ".local"));
  const legacy =
    store.get("workspace") ||
    (underRepoLocal ? root : null) ||
    path.join(dataDirectory || path.join(root, ".local"), "projects");
  const resolved = path.resolve(legacy);
  await fs.mkdir(resolved, { recursive: true });
  // Keep settings.workspace pointing at owner path for compatibility.
  store.set("workspace", resolved);
  return createWorkspace(store, {
    ownerUserId: owner.id,
    name: "CoffeeJack",
    rootPath: resolved,
    actorUserId: owner.id,
  });
}

/**
 * Default private workspace for non-owner users under .local/workspaces/<userId>.
 */
export async function ensureUserWorkspace(store, userId, dataDirectory) {
  const list = listWorkspacesForUser(store, userId);
  if (list.length) return list[0];
  const user = getUser(store, userId);
  const rootPath = path.join(dataDirectory, "workspaces", userId);
  return createWorkspace(store, {
    ownerUserId: userId,
    name: `${user?.display_name || "User"} Workspace`,
    rootPath,
    actorUserId: userId,
  });
}

export function getChatWorkspaceId(store, chatId) {
  if (!chatId) return null;
  const row = store.db
    .prepare("SELECT workspace_id FROM chats WHERE id=?")
    .get(chatId);
  return row?.workspace_id || null;
}

export function setChatWorkspace(store, chatId, workspaceId, userId) {
  const chat = store.chat(chatId, userId);
  if (!chat) throw new Error("Chat not found");
  if (!userCanAccessWorkspace(store, userId, workspaceId))
    throw new Error("Workspace access denied");
  store.db
    .prepare("UPDATE chats SET workspace_id=? WHERE id=? AND user_id=?")
    .run(workspaceId, chatId, userId);
  audit(store, {
    userId,
    action: "workspace_switched",
    detail: { chatId, workspaceId },
  });
}

/**
 * Resolve active workspace for a user/chat. Never returns another user's root.
 */
export async function resolveActiveWorkspace(
  store,
  user,
  { chatId = null, dataDirectory, root } = {},
) {
  if (!user?.id) throw new Error("User required");
  if (chatId) {
    const wid = getChatWorkspaceId(store, chatId);
    if (wid) {
      if (!userCanAccessWorkspace(store, user.id, wid)) {
        audit(store, {
          userId: user.id,
          action: "workspace_access_denied",
          detail: { workspaceId: wid, chatId },
        });
        throw new Error("Workspace access denied");
      }
      return getWorkspace(store, wid);
    }
  }
  const list = listWorkspacesForUser(store, user.id);
  if (list.length) return list[0];
  if (user.role === "owner")
    return ensureOwnerWorkspace(store, { root, dataDirectory });
  return ensureUserWorkspace(store, user.id, dataDirectory);
}

export function authorizeWorkspacePath(workspace, relativeOrAbs) {
  if (!workspace?.root_path) throw new Error("Workspace required");
  const root = path.resolve(workspace.root_path);
  const target = path.resolve(root, relativeOrAbs || ".");
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("Path escapes workspace");
  return { root, target, relative: rel || "." };
}

export function updateWorkspaceRoot(store, workspaceId, rootPath) {
  const resolved = path.resolve(rootPath);
  store.db
    .prepare(
      "UPDATE workspaces SET root_path=?, updated_at=? WHERE id=?",
    )
    .run(resolved, new Date().toISOString(), workspaceId);
  return getWorkspace(store, workspaceId);
}
