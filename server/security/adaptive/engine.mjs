/**
 * Adaptive defensive validation engine.
 * baseline → mutate → send → observe → classify → compare → learn → next
 * Strict budgets. Cancellable. Authorized target_id only.
 */

import { randomUUID } from "node:crypto";
import { lookupExpected } from "./policy-model.mjs";
import {
  baselineRequest,
  generateHttpMutations,
  generateNetworkMutations,
  generateRelatedFamily,
} from "./mutations.mjs";
import { observationRecord } from "./observations.mjs";
import { clampBudgets, remainingBudget, selectNextTests } from "./scorer.mjs";
import { lessonFromComparison } from "./lessons.mjs";
import { detectPolicyGaps } from "./gaps.mjs";
import { highlightPairs } from "./differential.mjs";
import { correlateTelemetry } from "./telemetry.mjs";
import { buildFuzzPlan, detectCrash, fuzzFinding } from "./fuzz.mjs";
import { securityResult } from "../evidence.mjs";

const ACTIVE = new Map();

function activeKey(dataDirectory) {
  return dataDirectory || ":memory:";
}

export function getActiveRun(dataDirectory) {
  return ACTIVE.get(activeKey(dataDirectory)) || null;
}

export function stopActiveRun(dataDirectory) {
  const current = ACTIVE.get(activeKey(dataDirectory));
  if (!current) return { stopped: false };
  current.controller.abort();
  current.stopped = true;
  return { stopped: true, run_id: current.runId };
}

async function executeCase({
  spec,
  target,
  policy,
  send,
  telemetry,
  phase,
}) {
  const expected = lookupExpected(
    {
      ...spec.request,
      category: spec.category,
      host: target.host,
    },
    policy,
  );
  const started = Date.now();
  let response;
  try {
    response = await send({
      target_id: target.target_id,
      ...spec.request,
    });
  } catch (error) {
    response = {
      error: error.message,
      code: error.code || "SEND_ERROR",
      status: null,
    };
  }
  const observed = observationRecord({
    testId: spec.case_id,
    request: spec.request,
    response,
    expected,
    latencyMs: Date.now() - started,
    telemetry: telemetry
      ? correlateTelemetry({ request: { ...spec.request, host: target.host }, ...telemetry })
      : { available: false, fabricated: false },
  });
  return {
    ...spec,
    ...observed,
    phase,
    control: spec.control || spec.category,
    target_id: target.target_id,
  };
}

export async function runAdaptiveValidation({
  target,
  policy,
  baseline,
  send,
  corpus,
  lessons,
  budgets,
  signal,
  dataDirectory,
  actor,
  includeFuzz = false,
  telemetry = null,
  now = () => new Date(),
} = {}) {
  if (!target?.target_id) {
    throw new Error("Adaptive validation requires target_id.");
  }
  if (typeof send !== "function") {
    return securityResult({
      tool: "security_lab",
      available: false,
      error: "Lab send adapter is not configured.",
      observed: { target_id: target.target_id },
    });
  }
  const limits = clampBudgets(budgets);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const runId = randomUUID();
  ACTIVE.set(activeKey(dataDirectory), {
    runId,
    controller,
    stopped: false,
    targetId: target.target_id,
  });
  const run = await corpus.createRun({
    run_id: runId,
    target_id: target.target_id,
    authorization_note: target.authorization_note,
    created_at: now().toISOString(),
    created_by: actor?.id || null,
    budgets: limits,
    policy,
  });

  try {
    const baseSpec = {
      case_id: `baseline-${runId.slice(0, 8)}`,
      target_id: target.target_id,
      family: "baseline",
      category: "baseline",
      request: baselineRequest(baseline || {}, target),
      recorded: true,
      note: "baseline",
    };
    const recorded = [];
    const baselineCase = await executeCase({
      spec: baseSpec,
      target,
      policy,
      send,
      telemetry,
      phase: "baseline",
    });
    recorded.push(baselineCase);
    await corpus.recordCase(runId, baselineCase);

    let used = 1;
    let round = 0;
    const room = Math.min(limits.maxCasesPerRound, limits.maxCasesPerRun - used);
    const netBudget = Math.min(8, Math.max(3, Math.floor(room / 3)));
    const httpBudget = Math.max(1, room - netBudget);
    const generated = [
      ...generateHttpMutations(baseSpec.request, {
        target,
        budget: httpBudget,
      }),
      ...generateNetworkMutations(baseSpec.request, {
        target,
        budget: netBudget,
      }),
    ];
    if (includeFuzz) generated.push(...buildFuzzPlan(baseSpec.request, target, Math.min(6, room)));

    const firstRound = generated.slice(0, room);
    for (const spec of firstRound) {
      if (controller.signal.aborted) break;
      const row = await executeCase({ spec, target, policy, send, telemetry, phase: "round-1" });
      recorded.push(row);
      await corpus.recordCase(runId, row);
      used += 1;
      const lesson = lessonFromComparison(row);
      if (lesson) await lessons.add(lesson);
    }
    round = 1;

    while (!controller.signal.aborted) {
      const left = remainingBudget({ used, round, budgets: limits });
      if (left.exhausted || left.remainingRun <= 0 || left.roundsLeft <= 0) break;
      const next = selectNextTests({
        cases: recorded,
        lessons: lessons.list({ targetId: target.target_id }),
        targetId: target.target_id,
        budget: Math.min(left.remainingRound, left.remainingRun),
        generateRelated: (seed, { budget }) =>
          generateRelatedFamily(seed, { target, budget }),
      });
      if (!next.length) break;
      round += 1;
      let produced = 0;
      for (const spec of next) {
        if (controller.signal.aborted) break;
        if (used >= limits.maxCasesPerRun) break;
        if (produced >= limits.maxCasesPerRound) break;
        const row = await executeCase({
          spec,
          target,
          policy,
          send,
          telemetry,
          phase: `round-${round}`,
        });
        recorded.push(row);
        await corpus.recordCase(runId, row);
        used += 1;
        produced += 1;
        const lesson = lessonFromComparison(row);
        if (lesson) await lessons.add(lesson);
      }
      if (!produced) break;
    }

    const findings = detectPolicyGaps(recorded, { policy });
    const differential = highlightPairs(recorded);
    const crashes = recorded
      .map((row) => ({ row, crash: detectCrash(row.response_metadata || {}) }))
      .filter((item) => item.crash.crashed)
      .map((item) => fuzzFinding(item.row, item.crash));
    const cancelled = controller.signal.aborted;
    await corpus.update(runId, {
      status: cancelled ? "stopped" : "complete",
      cancelled,
      stopped: cancelled,
      findings,
      case_count: recorded.length,
    });
    return securityResult({
      tool: "security_lab",
      observed: {
        action: "run",
        run_id: runId,
        target_id: target.target_id,
        authorization_note: target.authorization_note,
        case_count: recorded.length,
        rounds: round,
        budgets: limits,
        cancelled,
        baseline: recorded[0],
        cases: recorded,
        findings,
        differential,
        crashes,
        lessons: lessons.list({ targetId: target.target_id }),
      },
      derived: {
        mismatches: findings.length,
        interesting_pairs: differential.length,
      },
      expected: policy.expectations?.map((row) => `${row.match.method || "*"} ${row.match.path || "*"} → ${row.decision}`) || [],
      mismatch: findings.map((row) => row.gap),
      possibleCause: findings.map((row) => row.impact),
      recommendedRemediation: findings.map((row) => row.impact),
      assessment: cancelled
        ? ["Validation stopped before the budget was exhausted."]
        : [`Completed ${recorded.length} recorded lab case(s) within budget.`],
      unverified: recorded.some((row) => row.expected_decision === "unspecified")
        ? ["Some cases had no Owner-provided expectation; expected policy was not invented."]
        : [],
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    const current = ACTIVE.get(activeKey(dataDirectory));
    if (current?.runId === runId) ACTIVE.delete(activeKey(dataDirectory));
    void run;
  }
}

export { ACTIVE };
