import { randomUUID } from "node:crypto";

export const JOB_STATES = Object.freeze({
  PREPARED: "prepared",
  APPLIED: "applied",
  RESTORED: "restored",
  FAILED: "failed",
});

export function ensureGameSaveSchema(store) {
  const db = store?.db;
  if (!db) throw new Error("A CoffeeJack store is required");
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_save_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      edit_id TEXT NOT NULL,
      build_id TEXT,
      source_path TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      prepared_path TEXT,
      prepared_hash TEXT,
      backup_path TEXT,
      backup_hash TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      restored_at TEXT,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS game_save_jobs_user ON game_save_jobs(user_id, created_at);
  `);
}

function rowToJob(row) {
  if (!row) return null;
  return {
    ...row,
    meta: row.meta ? JSON.parse(row.meta) : {},
  };
}

export function createJob(store, fields) {
  ensureGameSaveSchema(store);
  const job = {
    id: fields.id || randomUUID(),
    user_id: fields.user_id,
    game_id: fields.game_id,
    edit_id: fields.edit_id,
    build_id: fields.build_id ?? null,
    source_path: fields.source_path,
    source_hash: fields.source_hash,
    prepared_path: fields.prepared_path ?? null,
    prepared_hash: fields.prepared_hash ?? null,
    backup_path: fields.backup_path ?? null,
    backup_hash: fields.backup_hash ?? null,
    state: fields.state || JOB_STATES.PREPARED,
    created_at: fields.created_at || new Date().toISOString(),
    applied_at: fields.applied_at ?? null,
    restored_at: fields.restored_at ?? null,
    meta: fields.meta || {},
  };
  store.db
    .prepare(
      `INSERT INTO game_save_jobs(
        id,user_id,game_id,edit_id,build_id,source_path,source_hash,
        prepared_path,prepared_hash,backup_path,backup_hash,state,
        created_at,applied_at,restored_at,meta
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      job.id,
      job.user_id,
      job.game_id,
      job.edit_id,
      job.build_id,
      job.source_path,
      job.source_hash,
      job.prepared_path,
      job.prepared_hash,
      job.backup_path,
      job.backup_hash,
      job.state,
      job.created_at,
      job.applied_at,
      job.restored_at,
      JSON.stringify(job.meta),
    );
  return job;
}

export function getJob(store, id, userId) {
  ensureGameSaveSchema(store);
  const row = store.db
    .prepare("SELECT * FROM game_save_jobs WHERE id=? AND user_id=?")
    .get(id, userId);
  return rowToJob(row);
}

export function listJobs(store, userId) {
  ensureGameSaveSchema(store);
  return store.db
    .prepare(
      "SELECT * FROM game_save_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 50",
    )
    .all(userId)
    .map(rowToJob);
}

export function updateJob(store, id, userId, fields) {
  ensureGameSaveSchema(store);
  const current = getJob(store, id, userId);
  if (!current) return null;
  const next = {
    ...current,
    ...fields,
    meta: fields.meta ? { ...current.meta, ...fields.meta } : current.meta,
  };
  store.db
    .prepare(
      `UPDATE game_save_jobs SET
        prepared_path=?, prepared_hash=?, backup_path=?, backup_hash=?,
        state=?, applied_at=?, restored_at=?, meta=?, build_id=?
       WHERE id=? AND user_id=?`,
    )
    .run(
      next.prepared_path,
      next.prepared_hash,
      next.backup_path,
      next.backup_hash,
      next.state,
      next.applied_at,
      next.restored_at,
      JSON.stringify(next.meta || {}),
      next.build_id,
      id,
      userId,
    );
  return getJob(store, id, userId);
}
