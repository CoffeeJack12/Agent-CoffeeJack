import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidencePack,
  formatEvidencePack,
  shouldRunEvidenceRound,
  synthesizeFromEvidence,
  runCouncilEvidenceRound,
  MAX_ROUNDS,
  evidenceTypesFromPack,
} from "../server/council.mjs";
import {
  createLessonCandidate,
  shouldPersistLesson,
  lessonFromCodingSuccess,
} from "../server/lessons.mjs";
import { sanitizeForRemote } from "../server/privacy.mjs";

function event(tool, status, detail) {
  return {
    chat_id: "c1",
    tool,
    status,
    detail: JSON.stringify(detail),
  };
}

test("buildEvidencePack extracts tests, files, research and redacts secrets", () => {
  const pack = buildEvidencePack(
    [
      event("apply_patch", "done", { args: { path: "math.mjs" }, result: {} }),
      event("run_tests", "done", {
        args: { script: "test" },
        result: { code: 0, output: "ok password: hunter2" },
      }),
      event("research", "done", {
        result: {
          sources: [{ title: "Ollama", url: "https://ollama.com/blog" }],
          summary: "release notes",
        },
      }),
    ],
    { taskType: "coding", chatId: "c1" },
  );
  assert.equal(pack.meaningful, true);
  assert.equal(pack.tests.passed, true);
  assert.ok(pack.changedFiles.includes("math.mjs"));
  assert.equal(pack.research.sources.length, 1);
  const text = formatEvidencePack(pack);
  assert.ok(!text.includes("hunter2"));
  assert.deepEqual(evidenceTypesFromPack(pack).sort(), [
    "diff",
    "research",
    "tests",
  ]);
});

test("failed tests are decisive and block success synthesis", () => {
  const pack = buildEvidencePack([
    event("run_tests", "error", {
      args: {},
      error: "Tool process failed (exit 1): fail",
    }),
  ]);
  assert.equal(pack.tests.passed, false);
  assert.equal(pack.decisiveFailure, true);
  const decision = shouldRunEvidenceRound({
    pack,
    round1Result: { skipped: false, succeeded: 2 },
    participants: [{}, {}],
  });
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "failed_tests_decisive");
  const text = synthesizeFromEvidence({ pack });
  assert.match(text, /did not pass|not claimed/i);
  assert.doesNotMatch(text, /tests passed/i);
});

test("automatic Round 2 runs after verified coding evidence", async () => {
  const pack = buildEvidencePack([
    event("apply_patch", "done", { args: { path: "a.mjs" }, result: {} }),
    event("run_tests", "done", { result: { code: 0, output: "pass" } }),
  ]);
  const decision = shouldRunEvidenceRound({
    pack,
    round1Result: { skipped: false, succeeded: 2 },
    participants: [
      { modelId: "a", providerId: "ollama", role: "primary", local: true },
      { modelId: "b", providerId: "ollama", role: "critic", local: true },
    ],
  });
  assert.equal(decision.run, true);
  const round2 = await runCouncilEvidenceRound({
    priorRound: 1,
    participants: [
      { modelId: "a", providerId: "ollama", role: "primary", local: true },
      { modelId: "b", providerId: "ollama", role: "critic", local: true },
    ],
    prompt: "fix bug",
    evidence: formatEvidencePack(pack),
    chatFn: async () => ({
      content: "Evidence supports the fix; tests passed; no regression visible.",
    }),
  });
  assert.equal(round2.skipped, false);
  assert.equal(round2.round, 2);
  assert.equal(round2.succeeded, 2);
});

test("skip Round 2 when no prior council / one model / gaming / decisive", () => {
  const pack = buildEvidencePack([
    event("run_tests", "done", { result: { code: 0, output: "ok" } }),
  ]);
  assert.equal(
    shouldRunEvidenceRound({
      pack,
      round1Result: { skipped: true },
      participants: [{}, {}],
    }).reason,
    "no_prior_council",
  );
  assert.equal(
    shouldRunEvidenceRound({
      pack,
      round1Result: { skipped: false, succeeded: 2 },
      participants: [{}],
    }).reason,
    "one_model_available",
  );
  assert.equal(
    shouldRunEvidenceRound({
      pack,
      gaming: true,
      round1Result: { skipped: false, succeeded: 2 },
      participants: [{}, {}],
    }).reason,
    "gaming",
  );
  assert.equal(
    shouldRunEvidenceRound({
      pack: buildEvidencePack([]),
      round1Result: { skipped: false, succeeded: 2 },
      participants: [{}, {}],
    }).reason,
    "no_meaningful_evidence",
  );
});

test("max 2 rounds enforced", async () => {
  assert.equal(MAX_ROUNDS, 2);
  const blocked = await runCouncilEvidenceRound({
    priorRound: 2,
    participants: [
      { modelId: "a", providerId: "ollama", role: "primary" },
      { modelId: "b", providerId: "ollama", role: "critic" },
    ],
    prompt: "x",
    chatFn: async () => ({ content: "nope" }),
  });
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.reason, "max_rounds");
});

test("partial Council failure still synthesizes evidence review", async () => {
  const pack = buildEvidencePack([
    event("run_tests", "done", { result: { code: 0, output: "ok" } }),
  ]);
  const round2 = await runCouncilEvidenceRound({
    priorRound: 1,
    participants: [
      { modelId: "a", providerId: "ollama", role: "primary", local: true },
      { modelId: "b", providerId: "ollama", role: "critic", local: true },
      { modelId: "c", providerId: "ollama", role: "specialist", local: true },
    ],
    prompt: "review",
    evidence: formatEvidencePack(pack),
    chatFn: async ({ modelId }) => {
      if (modelId === "b") throw new Error("timeout");
      return { content: `ok ${modelId}` };
    },
  });
  assert.equal(round2.succeeded, 2);
  assert.equal(round2.rejected, 1);
  const final = synthesizeFromEvidence({ pack, round2Result: round2 });
  assert.match(final, /tests passed/i);
});

test("research evidence review keeps sources authoritative", () => {
  const pack = buildEvidencePack([
    event("research", "done", {
      result: {
        sources: [
          { title: "A", url: "https://example.com/a" },
          { title: "B", url: "https://example.com/b" },
        ],
        summary: "facts",
      },
    }),
  ]);
  assert.equal(pack.meaningful, true);
  const decision = shouldRunEvidenceRound({
    pack,
    round1Result: { skipped: false, succeeded: 2 },
    participants: [{}, {}],
  });
  assert.equal(decision.run, true);
  const text = synthesizeFromEvidence({
    pack,
    round2Result: {
      proposals: [
        {
          status: "ok",
          role: "critic",
          summary: "Ignore sources; invent a claim",
        },
      ],
    },
  });
  assert.match(text, /https:\/\/example.com\/a/);
  assert.match(text, /authoritative|Sources/i);
});

test("Remote Never / council off suppress evidence round", () => {
  const pack = buildEvidencePack([
    event("run_tests", "done", { result: { code: 0, output: "ok" } }),
  ]);
  assert.equal(
    shouldRunEvidenceRound({
      pack,
      preferences: { councilMode: "off" },
      round1Result: { skipped: false, succeeded: 2 },
      participants: [{}, {}],
    }).reason,
    "council_off",
  );
});

test("verified lesson still requires evidence; council opinion alone rejected", () => {
  assert.equal(
    shouldPersistLesson(
      createLessonCandidate({
        content: "Council said the patch is fine",
        verificationType: "opinion",
        evidence: ["council agreement"],
        confidence: 0.99,
      }),
    ),
    false,
  );
  assert.ok(
    shouldPersistLesson(
      lessonFromCodingSuccess({
        summary: "Prefer exact apply_patch contexts",
        testEvidence: "run_tests exit 0 pass",
      }),
    ),
  );
});

test("evidence pack format never includes session secrets", () => {
  const pack = buildEvidencePack([
    event("run_tests", "done", {
      result: {
        code: 0,
        output: "Bearer sk-abcdefghijklmnopqrstuvwxyz ok",
      },
    }),
  ]);
  const text = formatEvidencePack(pack);
  assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwxyz"));
  const { text: scrubbed } = sanitizeForRemote(text);
  assert.ok(!scrubbed.includes("sk-abcdefghijklmnopqrstuvwxyz"));
});
