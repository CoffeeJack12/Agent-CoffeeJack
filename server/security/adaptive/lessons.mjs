/**
 * Security-lab lessons. Evidence-based. Target-scoped.
 * A lesson may influence TEST GENERATION for the same target_id only.
 * It never silently becomes authorization for another target.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function createLessonStore({ dataDirectory, now = () => new Date() } = {}) {
  const file = dataDirectory
    ? path.join(dataDirectory, "security", "lab", "lessons.json")
    : null;
  let lessons = [];

  async function persist() {
    if (!file) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ lessons }, null, 2), "utf8");
  }

  async function load() {
    if (!file) return;
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      lessons = Array.isArray(raw?.lessons) ? raw.lessons : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return {
    load,
    persist,
    list({ targetId = null } = {}) {
      if (!targetId) return lessons.map((row) => ({ ...row }));
      return lessons.filter((row) => row.target_id === targetId).map((row) => ({ ...row }));
    },
    add(input) {
      if (!input?.target_id) {
        throw new Error("Lab lessons require target_id.");
      }
      if (!input.observation) {
        throw new Error("Lab lessons require an evidence-based observation.");
      }
      const lesson = {
        id: input.id || randomUUID(),
        control: input.control || "unknown",
        target_id: input.target_id,
        observation: String(input.observation),
        confidence: ["high", "medium", "low"].includes(input.confidence)
          ? input.confidence
          : "medium",
        evidence: Array.isArray(input.evidence) ? input.evidence : [],
        timestamp: input.timestamp || now().toISOString(),
        influences: "test_generation",
        authorizesOtherTargets: false,
      };
      lessons.push(lesson);
      return persist().then(() => ({ ...lesson }));
    },
    async clear(actor) {
      if (String(actor?.role || "").toLowerCase() !== "owner") {
        const error = new Error("Only Owner can clear lab lessons.");
        error.code = "LAB_OWNER_ONLY";
        throw error;
      }
      lessons = [];
      await persist();
      return { cleared: true };
    },
    forGeneration(targetId) {
      return this.list({ targetId }).map((row) => ({
        control: row.control,
        observation: row.observation,
        confidence: row.confidence,
        target_id: row.target_id,
      }));
    },
    authorizes(targetId, otherTargetId) {
      if (!targetId || !otherTargetId || targetId === otherTargetId) return false;
      return false;
    },
  };
}

export function lessonFromComparison(recorded, { control = "WAF" } = {}) {
  if (!recorded?.target_id) return null;
  if (recorded.expected_decision === "unspecified") return null;
  if (recorded.expected_decision === recorded.observed_decision) return null;
  return {
    control,
    target_id: recorded.target_id,
    observation: `${recorded.category || "case"} expected ${recorded.expected_decision} but observed ${recorded.observed_decision}${recorded.note ? ` (${recorded.note})` : ""}`,
    confidence: recorded.expected_decision === "block" && recorded.observed_decision === "allow"
      ? "high"
      : "medium",
    evidence: [
      {
        test_id: recorded.test_id || recorded.case_id,
        expected: recorded.expected_decision,
        observed: recorded.observed_decision,
        status: recorded.status ?? null,
      },
    ],
  };
}
