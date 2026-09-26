/**
 * Bounded protocol fuzzing for lab targets.
 * Crash detection is allowed. Exploit chains are never constructed.
 */

import { generateSafeFuzzCases, looksLikeExploitPayload } from "./mutations.mjs";

export function detectCrash(response = {}) {
  if (response.crash === true || response.processCrashed === true) {
    return {
      crashed: true,
      evidence: response.crashEvidence || "Adapter reported a process crash.",
      chain: false,
    };
  }
  if (response.code === "ECONNRESET" && response.afterMalformed) {
    return {
      crashed: true,
      evidence: "Connection reset after a malformed-but-non-exploit input.",
      chain: false,
    };
  }
  return { crashed: false, evidence: null, chain: false };
}

export function buildFuzzPlan(baseline, target, budget = 10) {
  return generateSafeFuzzCases(baseline, { target, budget }).filter(
    (row) => !looksLikeExploitPayload(JSON.stringify(row.request || {})),
  );
}

export function fuzzFinding(recorded, crash) {
  return {
    target_id: recorded.target_id,
    case_id: recorded.case_id,
    crashed: Boolean(crash?.crashed),
    exploit_chain: false,
    reproducible: {
      category: recorded.category,
      request: recorded.request,
      note: recorded.note,
    },
    evidence: crash?.evidence || null,
  };
}
