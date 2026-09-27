/**
 * Persistent recorded lab cases. Local only. Separate from chat memory.
 */

import fs from "node:fs/promises";
import path from "node:path";

export function createCorpus({ dataDirectory } = {}) {
  const root = dataDirectory
    ? path.join(dataDirectory, "security", "lab", "runs")
    : null;
  const memory = new Map();

  function fileFor(runId) {
    return root ? path.join(root, `${runId}.json`) : null;
  }

  async function readRun(runId) {
    if (memory.has(runId)) return memory.get(runId);
    const file = fileFor(runId);
    if (!file) return null;
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      memory.set(runId, raw);
      return raw;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function writeRun(run) {
    memory.set(run.run_id, run);
    const file = fileFor(run.run_id);
    if (!file) return run;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(run, null, 2), "utf8");
    return run;
  }

  return {
    async createRun(meta) {
      const run = {
        run_id: meta.run_id,
        target_id: meta.target_id,
        authorization_note: meta.authorization_note || null,
        created_at: meta.created_at || new Date().toISOString(),
        created_by: meta.created_by || null,
        status: "active",
        budgets: meta.budgets || {},
        policy: meta.policy || { invented: false },
        cases: [],
        lessons: [],
        findings: [],
        stopped: false,
        cancelled: false,
      };
      return writeRun(run);
    },
    async recordCase(runId, recorded) {
      const run = (await readRun(runId)) || {
        run_id: runId,
        cases: [],
        lessons: [],
        findings: [],
      };
      run.cases = run.cases || [];
      run.cases.push(recorded);
      return writeRun(run);
    },
    async update(runId, patch) {
      const run = await readRun(runId);
      if (!run) return null;
      Object.assign(run, patch);
      return writeRun(run);
    },
    async get(runId) {
      return readRun(runId);
    },
    async list() {
      if (!root) return [...memory.values()];
      try {
        const names = await fs.readdir(root);
        const rows = [];
        for (const name of names.filter((n) => n.endsWith(".json"))) {
          rows.push(await readRun(name.replace(/\.json$/, "")));
        }
        return rows.filter(Boolean);
      } catch (error) {
        if (error.code === "ENOENT") return [...memory.values()];
        throw error;
      }
    },
    cases(runId) {
      return memory.get(runId)?.cases || [];
    },
  };
}
