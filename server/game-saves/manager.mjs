import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Buffer, sha256File, hashesEqual } from "./hashing.mjs";
import { isInsideDir, redactEvidence, redactPath, uniqueTimestampName } from "./paths.mjs";
import { resolveAdapter } from "./adapters/index.mjs";
import {
  createJob,
  getJob,
  listJobs,
  updateJob,
  ensureGameSaveSchema,
  JOB_STATES,
} from "./jobs.mjs";
import { parseGvas, serializeGvas, cloneSave } from "./gvas.mjs";
import { audit } from "../users.mjs";

const CLOSED_GAME_MESSAGE =
  "Save the game, return to the menu if appropriate, then close the game. CoffeeJack will re-check the process itself and will not trust a verbal claim that it closed.";

function evidence(extra = {}) {
  return {
    jobId: extra.jobId ?? null,
    game: extra.game ?? null,
    buildId: extra.buildId ?? null,
    sourcePath: extra.sourcePath ?? null,
    sourceHash: extra.sourceHash ?? null,
    backupPath: extra.backupPath ?? null,
    backupHash: extra.backupHash ?? null,
    preparedPath: extra.preparedPath ?? null,
    preparedHash: extra.preparedHash ?? null,
    processRunning: extra.processRunning ?? false,
    compatibility: extra.compatibility ?? null,
    saveModified: extra.saveModified === true,
    installedVerified: extra.installedVerified === true,
    gameplayConfirmed: false,
    activationInstructions: extra.activationInstructions ?? null,
    ...extra,
    gameplayConfirmed: false,
  };
}

function fail(code, message, extra = {}) {
  return evidence({
    ok: false,
    code,
    message,
    ...extra,
  });
}

export class GameSaveManager {
  constructor({
    store,
    root,
    user,
    allowFixtures = false,
    fixtureRoot = null,
    liveMutations = true,
    steamRoots = [],
    saveRoots = [],
    processes = null,
    adapter = null,
    adapters = null,
  } = {}) {
    this.store = store;
    this.root = root;
    this.user = user;
    this.allowFixtures = allowFixtures;
    this.fixtureRoot = fixtureRoot;
    this.liveMutations = liveMutations;
    this.steamRoots = steamRoots;
    this.saveRoots = saveRoots;
    this.processes = processes;
    this.forcedAdapter = adapter;
    this.adapters = adapters;
    if (store) ensureGameSaveSchema(store);
  }

  get userId() {
    const id = this.user?.id;
    if (!id) throw new Error("game_save_user_required");
    return id;
  }

  editsDir(jobId) {
    return path.join(this.root, ".local", "game-save-edits", this.userId, jobId);
  }

  audit(action, detail) {
    if (!this.store) return;
    try {
      audit(this.store, {
        userId: this.user?.id ?? null,
        action,
        detail: redactEvidence(detail),
      });
    } catch {
      /* audit must not break the tool */
    }
  }

  resolveGameAdapter(game) {
    if (this.forcedAdapter) return this.forcedAdapter;
    if (this.adapters?.length) {
      const key = String(game || "").trim().toLowerCase();
      return (
        this.adapters.find((a) => a.matches?.(key) || a.id === key) ||
        this.adapters[0]
      );
    }
    return resolveAdapter(game);
  }

  discoveryContext(signal) {
    return {
      signal,
      steamRoots: this.steamRoots,
      saveRoots: this.saveRoots,
      processes: this.processes,
    };
  }

  authorizeSourcePath(filePath) {
    if (!filePath) return fail("missing_source", "No save file was identified");
    if (this.allowFixtures && this.fixtureRoot && isInsideDir(filePath, this.fixtureRoot))
      return { ok: true, fixture: true };
    if (this.allowFixtures && this.root && isInsideDir(filePath, path.join(this.root, ".local")))
      return { ok: true, fixture: true };
    if (!this.liveMutations)
      return fail(
        "live_mutation_disabled",
        "Live game-save writes are disabled in this session. Use a fixture copy.",
        { sourcePath: redactPath(filePath) },
      );
    return { ok: true, fixture: false };
  }

  async discover(game, { signal } = {}) {
    const adapter = this.resolveGameAdapter(game);
    if (!adapter) return fail("unknown_game", "No game-save adapter matches that title");
    const install = await adapter.discoverInstall(this.discoveryContext(signal));
    const buildId = adapter.discoverBuild(install);
    const processInfo = await adapter.discoverProcesses(install, this.discoveryContext(signal));
    const saves = await adapter.discoverSaves(this.discoveryContext(signal));
    return {
      ok: true,
      adapter,
      install,
      buildId,
      processInfo,
      saves,
    };
  }

  async inspect({ game, editId = "infinite_ammo", signal } = {}) {
    try {
      const discovered = await this.discover(game, { signal });
      if (!discovered.ok) {
        this.audit("game_save_failed", { phase: "inspect", code: discovered.code });
        return discovered;
      }
      const { adapter, install, buildId, processInfo, saves } = discovered;
      const selected = saves.selected;
      let parsed = null;
      let sourceHash = null;
      let parseError = null;
      if (selected?.path) {
        const buffer = await fs.readFile(selected.path);
        sourceHash = sha256Buffer(buffer);
        try {
          parsed = adapter.parse(buffer);
        } catch (error) {
          parseError = error.code || error.message;
        }
      }
      const compatibility = adapter.compatibility(parsed, buildId);
      const result = evidence({
        ok: true,
        game: adapter.id,
        buildId,
        sourcePath: selected?.path || null,
        sourceHash,
        processRunning: Boolean(processInfo.running),
        processMatches: processInfo.matches || [],
        compatibility,
        install: {
          found: Boolean(install?.found),
          appId: install?.appId || adapter.distribution?.appId || null,
          installDir: install?.installDir || null,
        },
        saveDiscovery: {
          reason: saves.reason,
          candidateCount: (saves.candidates || saves.files || []).length,
          selectedName: selected?.name || null,
        },
        parseError,
        supportedEdits: adapter.edits,
        requestedEdit: editId,
        activationInstructions: adapter.activationInstructions(editId, {}),
        requiresGameClosed: false,
      });
      this.audit("game_save_inspected", {
        game: adapter.id,
        buildId,
        processRunning: result.processRunning,
        compatibility: compatibility.status,
        reasons: compatibility.reasons,
      });
      return result;
    } catch (error) {
      const result = fail(error.code || "inspect_failed", error.message);
      this.audit("game_save_failed", { phase: "inspect", code: result.code });
      return result;
    }
  }

  async prepare({ game, editId = "infinite_ammo", signal } = {}) {
    try {
      const discovered = await this.discover(game, { signal });
      if (!discovered.ok) return discovered;
      const { adapter, install, buildId, processInfo, saves } = discovered;
      if (processInfo.running) {
        const blocked = fail("requires_game_closed", CLOSED_GAME_MESSAGE, {
          game: adapter.id,
          buildId,
          processRunning: true,
          requiresGameClosed: true,
          processMatches: processInfo.matches,
        });
        this.audit("game_save_failed", { phase: "prepare", code: blocked.code });
        return blocked;
      }
      if (!saves.selected?.path) {
        return fail("autosave_not_identified", "A confident autosave was not identified", {
          game: adapter.id,
          buildId,
          candidates: (saves.candidates || []).map((c) => c.name),
          reason: saves.reason,
        });
      }
      const sourcePath = saves.selected.path;
      const allowed = this.authorizeSourcePath(sourcePath);
      if (!allowed.ok) return allowed;
      const compatibility = adapter.compatibility(null, buildId);
      if (!compatibility.buildSupported) {
        return fail("unsupported_version", "Write is refused for an unsupported build", {
          game: adapter.id,
          buildId,
          compatibility: adapter.compatibility(null, buildId),
        });
      }
      const source = await fs.readFile(sourcePath);
      const sourceHash = sha256Buffer(source);
      let parsed;
      try {
        parsed = adapter.parse(source);
      } catch (error) {
        return fail(error.code || "parse_failed", error.message, {
          game: adapter.id,
          buildId,
          sourceHash,
        });
      }
      const compat = adapter.compatibility(parsed, buildId);
      if (!compat.writable) {
        return fail(compat.reasons[0] || "incompatible_save", "Save is not writable by this adapter", {
          game: adapter.id,
          buildId,
          sourcePath,
          sourceHash,
          compatibility: compat,
        });
      }
      const before = cloneSave(parsed);
      const mutation = adapter.prepareMutation(parsed, editId);
      if (!mutation.ok) {
        return fail(mutation.code, mutation.message, {
          game: adapter.id,
          buildId,
          sourcePath,
          sourceHash,
          compatibility: compat,
        });
      }
      const preparedBuffer = adapter.serialize(parsed);
      const roundTrip = adapter.parse(preparedBuffer);
      const structure = adapter.validateStructure(roundTrip);
      if (!structure.ok) {
        return fail(structure.code, structure.message, {
          game: adapter.id,
          buildId,
          sourceHash,
        });
      }
      const preservation = adapter.validatePreservation(before, roundTrip);
      if (!preservation.ok) {
        return fail("preservation_failed", "Unrelated save data would change", {
          game: adapter.id,
          buildId,
          sourceHash,
          preservation: preservation.summary,
        });
      }
      const jobId = randomUUID();
      const dir = this.editsDir(jobId);
      await fs.mkdir(dir, { recursive: true });
      const ext = path.extname(sourcePath) || ".sav";
      const backupName = uniqueTimestampName("backup", ext);
      const backupPath = path.join(dir, backupName);
      try {
        await fs.stat(backupPath);
        return fail("backup_exists", "Refusing to overwrite an existing backup");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await fs.writeFile(backupPath, source, { flag: "wx" });
      const backupHash = await sha256File(backupPath);
      if (!hashesEqual(backupHash, sourceHash)) {
        return fail("backup_hash_mismatch", "Backup hash did not match the source");
      }
      const preparedPath = path.join(dir, `prepared${ext}`);
      await fs.writeFile(preparedPath, preparedBuffer, { flag: "wx" });
      const preparedHash = sha256Buffer(preparedBuffer);
      const job = createJob(this.store, {
        id: jobId,
        user_id: this.userId,
        game_id: adapter.id,
        edit_id: editId,
        build_id: buildId,
        source_path: sourcePath,
        source_hash: sourceHash,
        prepared_path: preparedPath,
        prepared_hash: preparedHash,
        backup_path: backupPath,
        backup_hash: backupHash,
        state: JOB_STATES.PREPARED,
        meta: {
          added: mutation.added,
          alreadyPresent: mutation.alreadyPresent,
          preservation: preservation.summary,
          fixture: Boolean(allowed.fixture),
          installDir: install?.installDir || null,
        },
      });
      const result = evidence({
        ok: true,
        jobId: job.id,
        game: adapter.id,
        buildId,
        sourcePath,
        sourceHash,
        backupPath,
        backupHash,
        preparedPath,
        preparedHash,
        processRunning: false,
        compatibility: compat,
        mutation,
        preservation: preservation.summary,
        activationInstructions: adapter.activationInstructions(editId, mutation),
        saveModified: false,
        installedVerified: false,
      });
      this.audit("game_save_prepared", {
        jobId: job.id,
        game: adapter.id,
        buildId,
        sourceHash,
        backupHash,
        preparedHash,
        added: mutation.added,
      });
      return result;
    } catch (error) {
      const result = fail(error.code || "prepare_failed", error.message);
      this.audit("game_save_failed", { phase: "prepare", code: result.code });
      return result;
    }
  }

  async apply({ jobId, signal } = {}) {
    try {
      if (!jobId) return fail("missing_job", "jobId is required");
      const job = getJob(this.store, jobId, this.userId);
      if (!job) return fail("job_not_found", "No game-save job belongs to this user");
      const adapter = this.resolveGameAdapter(job.game_id);
      const discovered = await this.discover(job.game_id, { signal });
      if (discovered.ok && discovered.processInfo.running) {
        const blocked = fail("requires_game_closed", CLOSED_GAME_MESSAGE, {
          jobId,
          game: job.game_id,
          buildId: job.build_id,
          processRunning: true,
          requiresGameClosed: true,
        });
        this.audit("game_save_failed", { phase: "apply", code: blocked.code, jobId });
        return blocked;
      }
      const allowed = this.authorizeSourcePath(job.source_path);
      if (!allowed.ok) return allowed;
      const currentHash = await sha256File(job.source_path);
      if (!hashesEqual(currentHash, job.source_hash)) {
        const conflict = fail(
          "source_changed_since_prepare",
          "Live save hash changed after prepare. Apply is refused; the file was not overwritten.",
          {
            jobId,
            game: job.game_id,
            buildId: job.build_id,
            sourcePath: job.source_path,
            sourceHash: job.source_hash,
            currentHash,
            backupPath: job.backup_path,
            backupHash: job.backup_hash,
            preparedPath: job.prepared_path,
            preparedHash: job.prepared_hash,
          },
        );
        this.audit("game_save_apply_conflict", {
          jobId,
          code: conflict.code,
          sourceHash: job.source_hash,
          currentHash,
        });
        return conflict;
      }
      const prepared = await fs.readFile(job.prepared_path);
      const preparedHash = sha256Buffer(prepared);
      if (!hashesEqual(preparedHash, job.prepared_hash)) {
        return fail("prepared_hash_mismatch", "Prepared file hash no longer matches the job");
      }
      const installed = await this.atomicInstall(job.source_path, prepared, preparedHash);
      if (!installed.ok) {
        this.audit("game_save_failed", { phase: "apply", code: installed.code, jobId });
        return fail(installed.code, installed.message, { jobId, game: job.game_id });
      }
      const live = await fs.readFile(job.source_path);
      const installedHash = sha256Buffer(live);
      if (!hashesEqual(installedHash, job.prepared_hash)) {
        await this.atomicInstall(job.source_path, await fs.readFile(job.backup_path), job.backup_hash);
        return fail("installed_hash_mismatch", "Installed save hash did not match the prepared file");
      }
      const parsed = adapter.parse(live);
      const structure = adapter.validateStructure(parsed);
      if (!structure.ok) {
        await this.atomicInstall(job.source_path, await fs.readFile(job.backup_path), job.backup_hash);
        return fail(structure.code, "Installed save failed structural validation; original restored");
      }
      updateJob(this.store, job.id, this.userId, {
        state: JOB_STATES.APPLIED,
        applied_at: new Date().toISOString(),
      });
      const result = evidence({
        ok: true,
        jobId: job.id,
        game: job.game_id,
        buildId: job.build_id,
        sourcePath: job.source_path,
        sourceHash: job.source_hash,
        backupPath: job.backup_path,
        backupHash: job.backup_hash,
        preparedPath: job.prepared_path,
        preparedHash: job.prepared_hash,
        installedHash,
        processRunning: false,
        saveModified: true,
        installedVerified: true,
        activationInstructions: adapter.activationInstructions(job.edit_id, job.meta || {}),
        note: "The save was modified and verified on disk. Gameplay behavior is still unconfirmed until you launch the game and test it.",
      });
      this.audit("game_save_applied", {
        jobId: job.id,
        game: job.game_id,
        installedHash,
        saveModified: true,
        installedVerified: true,
        gameplayConfirmed: false,
      });
      return result;
    } catch (error) {
      const result = fail(error.code || "apply_failed", error.message, { jobId });
      this.audit("game_save_failed", { phase: "apply", code: result.code, jobId });
      return result;
    }
  }

  async restore({ jobId, signal } = {}) {
    try {
      if (!jobId) return fail("missing_job", "jobId is required");
      const job = getJob(this.store, jobId, this.userId);
      if (!job) return fail("job_not_found", "No game-save job belongs to this user");
      const adapter = this.resolveGameAdapter(job.game_id);
      const discovered = await this.discover(job.game_id, { signal });
      if (discovered.ok && discovered.processInfo.running) {
        return fail("requires_game_closed", CLOSED_GAME_MESSAGE, {
          jobId,
          game: job.game_id,
          processRunning: true,
          requiresGameClosed: true,
        });
      }
      const allowed = this.authorizeSourcePath(job.source_path);
      if (!allowed.ok) return allowed;
      const backup = await fs.readFile(job.backup_path);
      const backupHash = sha256Buffer(backup);
      if (!hashesEqual(backupHash, job.backup_hash)) {
        return fail("backup_hash_mismatch", "Selected backup failed hash validation");
      }
      const live = await fs.readFile(job.source_path);
      const undoName = uniqueTimestampName("restore-undo", path.extname(job.source_path) || ".sav");
      const undoPath = path.join(this.editsDir(job.id), undoName);
      await fs.mkdir(path.dirname(undoPath), { recursive: true });
      await fs.writeFile(undoPath, live, { flag: "wx" });
      const undoHash = sha256Buffer(live);
      const installed = await this.atomicInstall(job.source_path, backup, backupHash);
      if (!installed.ok) {
        this.audit("game_save_failed", { phase: "restore", code: installed.code, jobId });
        return fail(installed.code, installed.message, { jobId });
      }
      const restoredHash = await sha256File(job.source_path);
      if (!hashesEqual(restoredHash, job.backup_hash)) {
        return fail("restore_hash_mismatch", "Restored save hash did not match the backup");
      }
      try {
        adapter.parse(await fs.readFile(job.source_path));
      } catch (error) {
        return fail(error.code || "restore_parse_failed", error.message, { jobId });
      }
      updateJob(this.store, job.id, this.userId, {
        state: JOB_STATES.RESTORED,
        restored_at: new Date().toISOString(),
        meta: { restoreUndoPath: undoPath, restoreUndoHash: undoHash },
      });
      const result = evidence({
        ok: true,
        jobId: job.id,
        game: job.game_id,
        buildId: job.build_id,
        sourcePath: job.source_path,
        sourceHash: job.source_hash,
        backupPath: job.backup_path,
        backupHash: job.backup_hash,
        restoreUndoPath: undoPath,
        restoreUndoHash: undoHash,
        restoredHash,
        saveModified: true,
        installedVerified: true,
        processRunning: false,
      });
      this.audit("game_save_restored", {
        jobId: job.id,
        restoredHash,
        backupHash: job.backup_hash,
      });
      return result;
    } catch (error) {
      const result = fail(error.code || "restore_failed", error.message, { jobId });
      this.audit("game_save_failed", { phase: "restore", code: result.code, jobId });
      return result;
    }
  }

  async backups({ jobId } = {}) {
    const jobs = jobId
      ? [getJob(this.store, jobId, this.userId)].filter(Boolean)
      : listJobs(this.store, this.userId);
    return {
      ok: true,
      gameplayConfirmed: false,
      backups: jobs.map((job) => ({
        jobId: job.id,
        game: job.game_id,
        editId: job.edit_id,
        state: job.state,
        backupPath: job.backup_path,
        backupHash: job.backup_hash,
        preparedHash: job.prepared_hash,
        createdAt: job.created_at,
      })),
    };
  }

  async atomicInstall(targetPath, buffer, expectedHash) {
    const dir = path.dirname(targetPath);
    const ext = path.extname(targetPath) || ".sav";
    const staging = path.join(dir, `.coffeejack-staging-${randomUUID()}${ext}`);
    const rollback = path.join(dir, `.coffeejack-rollback-${randomUUID()}${ext}`);
    await fs.writeFile(staging, buffer);
    const stagingHash = await sha256File(staging);
    if (!hashesEqual(stagingHash, expectedHash)) {
      await fs.rm(staging, { force: true });
      return { ok: false, code: "staging_hash_mismatch", message: "Staging file hash mismatch" };
    }
    let hadTarget = false;
    try {
      await fs.rename(targetPath, rollback);
      hadTarget = true;
    } catch (error) {
      if (error.code !== "ENOENT") {
        await fs.rm(staging, { force: true });
        throw error;
      }
    }
    try {
      await fs.rename(staging, targetPath);
    } catch (error) {
      if (hadTarget) await fs.rename(rollback, targetPath).catch(() => {});
      await fs.rm(staging, { force: true });
      return { ok: false, code: "install_rename_failed", message: error.message };
    }
    const installedHash = await sha256File(targetPath);
    if (!hashesEqual(installedHash, expectedHash)) {
      if (hadTarget) await fs.rename(rollback, targetPath).catch(() => {});
      else await fs.rm(targetPath, { force: true });
      return {
        ok: false,
        code: "installed_verification_failed",
        message: "Installed file failed hash verification; original restored",
      };
    }
    if (hadTarget) await fs.rm(rollback, { force: true });
    return { ok: true, installedHash };
  }
}

export function createGameSaveManager(options) {
  return new GameSaveManager(options);
}
