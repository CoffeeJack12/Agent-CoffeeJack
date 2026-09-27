/**
 * Adaptive Security Validation Lab toolkit.
 * Owner-authorized targets only. Local learning. No stealth or exploits.
 */

import { securityResult } from "../evidence.mjs";
import { createTargetRegistry } from "./registry.mjs";
import { normalizeLabPolicy, lookupExpected } from "./policy-model.mjs";
import {
  generateHttpMutations,
  generateNetworkMutations,
  generateRelatedFamily,
  generateSafeFuzzCases,
  baselineRequest,
} from "./mutations.mjs";
import { observationRecord } from "./observations.mjs";
import { createCorpus } from "./corpus.mjs";
import { clampBudgets } from "./scorer.mjs";
import { createLessonStore, lessonFromComparison } from "./lessons.mjs";
import { correlateTelemetry } from "./telemetry.mjs";
import { compareCases, highlightPairs } from "./differential.mjs";
import { detectPolicyGaps } from "./gaps.mjs";
import { runRateLimitTest } from "./rate-limit.mjs";
import { buildFirewallMatrix } from "./matrix.mjs";
import { buildValidationReport } from "./report.mjs";
import { detectLabEnvironment } from "./detect-lab.mjs";
import { runAdaptiveValidation, stopActiveRun, getActiveRun } from "./engine.mjs";

export const LAB_TOOLS = Object.freeze(["security_lab"]);

export const LAB_AUDIT = Object.freeze({
  security_lab: "security_lab_event",
  security_lab_run: "security_lab_run",
  security_lab_target: "security_lab_target_changed",
});

export const LAB_ACTIONS = Object.freeze([
  "targets_list",
  "targets_add",
  "targets_remove",
  "run",
  "stop",
  "report",
  "lessons",
  "clear_lessons",
  "findings",
  "matrix",
  "rate_limit",
  "fuzz",
  "environment",
  "plans",
  "evidence",
  "availability",
  "compare",
]);

export function classifyLabIntent(text = "") {
  const t = String(text || "").trim();
  if (!t) return null;
  if (
    /(?:security lab|adaptive validation|authorized target|policy gap|lab lesson|validation lab|control matrix)/i.test(
      t,
    )
  ) {
    return {
      kind: "security_lab",
      tool: "security_lab",
      effectiveIntent: "Run or inspect the Owner-controlled adaptive security validation lab.",
      directive: [
        "SECURITY LAB TURN.",
        "Call security_lab. Do not use terminal first.",
        "Every test must use target_id from the Owner authorized-target registry.",
        "Do not invent expected policy. Do not send raw packets or bodies to remote models.",
      ].join("\n"),
    };
  }
  return null;
}

function assertOwnerManage(user, action) {
  if (["targets_add", "targets_remove", "clear_lessons"].includes(action)) {
    if (String(user?.role || "").toLowerCase() !== "owner") {
      const error = new Error("Only Owner can manage authorized targets and lab lessons.");
      error.code = "LAB_OWNER_ONLY";
      throw error;
    }
  }
}

export function createLabToolkit({
  dataDirectory,
  user,
  adapters = {},
} = {}) {
  const registry = adapters.registry || createTargetRegistry({
    dataDirectory,
    initial: adapters.targets || [],
  });
  const lessons = adapters.lessons || createLessonStore({ dataDirectory });
  const corpus = adapters.corpus || createCorpus({ dataDirectory });
  const send =
    adapters.send ||
    adapters.http ||
    (async (request) => defaultAuthorizedSend(registry, request));
  const ready = Promise.all([
    registry.load?.(),
    lessons.load?.(),
  ]).catch(() => {});

  async function snapshot() {
    await ready;
    const runs = await corpus.list();
    const latest = runs.at(-1) || null;
    const env = detectLabEnvironment({ exists: adapters.exists });
    return {
      targets: registry.list(),
      lessons: lessons.list(),
      active: getActiveRun(dataDirectory),
      latest_run: latest
        ? {
            run_id: latest.run_id,
            target_id: latest.target_id,
            status: latest.status,
            case_count: latest.cases?.length || latest.case_count || 0,
          }
        : null,
      findings: latest?.findings || [],
      environment: env,
      availability: {
        lab: true,
        sendAdapter: typeof send === "function",
        runtimes: env.runtimes,
        adapters: env.adapters,
      },
    };
  }

  return {
    registry,
    lessons,
    corpus,
    snapshot,
    async execute(name, args = {}, signal) {
      if (name !== "security_lab") throw new Error(`Unknown lab tool: ${name}`);
      await ready;
      const action = String(args.action || "availability").toLowerCase();
      assertOwnerManage(user, action);

      if (action === "targets_list") {
        return securityResult({
          tool: "security_lab",
          observed: { action, targets: registry.list() },
        });
      }
      if (action === "targets_add") {
        const record = await registry.add(args.target || args, user);
        return securityResult({
          tool: "security_lab",
          observed: { action, target: record },
        });
      }
      if (action === "targets_remove") {
        const removed = await registry.remove(args.target_id || args.targetId, user);
        return securityResult({
          tool: "security_lab",
          observed: { action, ...removed },
        });
      }
      if (action === "stop") {
        return securityResult({
          tool: "security_lab",
          observed: { action, ...stopActiveRun(dataDirectory) },
        });
      }
      if (action === "lessons") {
        return securityResult({
          tool: "security_lab",
          observed: {
            action,
            target_id: args.target_id || null,
            lessons: lessons.list({ targetId: args.target_id || args.targetId || null }),
          },
        });
      }
      if (action === "clear_lessons") {
        const cleared = await lessons.clear(user);
        return securityResult({
          tool: "security_lab",
          observed: { action, ...cleared },
        });
      }
      if (action === "environment" || action === "availability") {
        const snap = await snapshot();
        return securityResult({
          tool: "security_lab",
          observed: { action, ...snap.availability, environment: snap.environment },
        });
      }
      if (action === "plans") {
        const target = args.target_id ? registry.require(args.target_id) : null;
        const baseline = target ? baselineRequest(args.baseline || {}, target) : null;
        return securityResult({
          tool: "security_lab",
          observed: {
            action,
            target_id: target?.target_id || null,
            http: target
              ? generateHttpMutations(baseline, { target, budget: args.budget || 25 })
              : [],
            network: target
              ? generateNetworkMutations(baseline, { target, budget: 12 })
              : [],
            fuzz: target ? generateSafeFuzzCases(baseline, { target, budget: 8 }) : [],
          },
        });
      }
      if (action === "compare") {
        return securityResult({
          tool: "security_lab",
          observed: {
            action,
            differential: compareCases(args.caseA || args.a, args.caseB || args.b),
          },
        });
      }
      if (action === "matrix") {
        return securityResult({
          tool: "security_lab",
          observed: {
            action,
            matrix: buildFirewallMatrix({
              intended: args.intended || args.policy || [],
              observed: args.observed || [],
              previous: args.previous || null,
            }),
          },
        });
      }
      if (action === "findings" || action === "evidence" || action === "report") {
        const run = args.run_id ? await corpus.get(args.run_id) : (await corpus.list()).at(-1);
        if (!run) {
          return securityResult({
            tool: "security_lab",
            observed: { action, run: null },
            unverified: ["No lab run is stored yet."],
          });
        }
        const target = registry.get(run.target_id);
        if (action === "report") {
          return securityResult({
            tool: "security_lab",
            observed: {
              action,
              report: buildValidationReport(run, {
                target,
                findings: run.findings || detectPolicyGaps(run.cases || []),
              }),
            },
          });
        }
        return securityResult({
          tool: "security_lab",
          observed: {
            action,
            run_id: run.run_id,
            target_id: run.target_id,
            findings: run.findings || detectPolicyGaps(run.cases || []),
            cases: (run.cases || []).map((row) => ({
              test_id: row.test_id || row.case_id,
              category: row.category,
              expected_decision: row.expected_decision,
              observed_decision: row.observed_decision,
              status: row.status ?? null,
              latency: row.latency ?? null,
            })),
            differential: highlightPairs(run.cases || []),
          },
        });
      }
      if (action === "rate_limit") {
        if (!args.target_id) registry.rejectArbitrary(args.target || args.host);
        const target = registry.require(args.target_id);
        const result = await runRateLimitTest({
          target,
          send,
          expectedThreshold: args.expectedThreshold,
          maxRequestRate: args.maxRequestRate,
          durationMs: args.durationMs || args.duration,
          signal,
          pathName: args.path || "/",
        });
        return securityResult({
          tool: "security_lab",
          available: result.available !== false,
          error: result.error || null,
          observed: { action, ...result },
        });
      }
      if (action === "fuzz") {
        if (!args.target_id) registry.rejectArbitrary(args.target || args.host);
        const target = registry.require(args.target_id);
        const cases = generateSafeFuzzCases(args.baseline || {}, { target, budget: 8 });
        return securityResult({
          tool: "security_lab",
          observed: { action, target_id: target.target_id, cases, exploit_chain: false },
        });
      }
      if (action === "run") {
        if (!args.target_id && (args.target || args.host || args.url)) {
          registry.rejectArbitrary(args.target || args.host || args.url);
        }
        const target = registry.require(args.target_id);
        const policy = normalizeLabPolicy(args.policy || {});
        return runAdaptiveValidation({
          target,
          policy,
          baseline: args.baseline || {},
          send,
          corpus,
          lessons,
          budgets: clampBudgets(args.budgets || args),
          signal,
          dataDirectory,
          actor: user,
          includeFuzz: Boolean(args.fuzz),
          telemetry: args.telemetry || adapters.telemetry || null,
        });
      }
      return securityResult({
        tool: "security_lab",
        error: "Unknown security lab action.",
        observed: { action },
      });
    },
  };
}

async function defaultAuthorizedSend(registry, request = {}) {
  if (!request.target_id) {
    const error = new Error("target_id is required.");
    error.code = "LAB_ARBITRARY_TARGET";
    throw error;
  }
  const target = registry.require(request.target_id);
  const protocol = request.tls || request.protocol === "https" ? "https" : "http";
  const port = request.port || target.ports[0] || (protocol === "https" ? 443 : 80);
  const pathName = request.path || "/";
  const query = request.query && Object.keys(request.query).length
    ? `?${new URLSearchParams(request.query)}`
    : "";
  const url = `${protocol}://${target.host}:${port}${pathName}${query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(url, {
      method: request.method || "GET",
      headers: request.headers || {},
      body: request.method && ["GET", "HEAD"].includes(request.method) ? undefined : request.body ?? undefined,
      signal: controller.signal,
      redirect: "manual",
    });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      httpVersion: "1.1",
    };
  } catch (error) {
    return {
      error: error.message,
      code: error.name === "AbortError" ? "ETIMEDOUT" : error.cause?.code || error.code || "SEND_ERROR",
      status: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export {
  createTargetRegistry,
  normalizeLabPolicy,
  lookupExpected,
  generateHttpMutations,
  generateNetworkMutations,
  generateRelatedFamily,
  generateSafeFuzzCases,
  baselineRequest,
  observationRecord,
  createCorpus,
  clampBudgets,
  createLessonStore,
  lessonFromComparison,
  correlateTelemetry,
  compareCases,
  detectPolicyGaps,
  runRateLimitTest,
  buildFirewallMatrix,
  buildValidationReport,
  detectLabEnvironment,
  runAdaptiveValidation,
  stopActiveRun,
  getActiveRun,
};
