/**
 * Policy gap reports. "Bypass" only when policy expected block and evidence shows allow.
 */

import { mayCallBypass } from "./policy-model.mjs";

export function detectPolicyGaps(cases = [], { policy = null } = {}) {
  const findings = [];
  for (const row of cases) {
    const expected = row.expected_decision || "unspecified";
    const observed = row.observed_decision;
    if (expected === "unspecified") continue;
    if (expected === observed) continue;
    const bypass = mayCallBypass(expected, observed);
    findings.push({
      finding_id: row.case_id || row.test_id,
      target_id: row.target_id,
      expected: `Configured policy says ${expected}${row.expected_source ? ` (source: ${row.expected_source})` : ""}.`,
      observed: `Observed ${observed}${row.status != null ? ` (status ${row.status})` : ""}.`,
      gap: `${row.category || "case"}: expected ${expected}, observed ${observed}.`,
      evidence: [
        {
          test_id: row.test_id || row.case_id,
          category: row.category,
          note: row.note || null,
          latency: row.latency ?? null,
        },
      ],
      impact: describeImpact(expected, observed, row),
      bypass: bypass ? "Configured defensive policy expected this to be blocked; evidence shows it was accepted." : false,
      policy_source: policy?.source || row.expected_source || "owner",
    });
  }
  return findings;
}

function describeImpact(expected, observed, row) {
  if (expected === "block" && observed === "allow") {
    return `A request classified as ${row.category || "variant"} reached the application when the declared policy said it should be blocked.`;
  }
  if (expected === "allow" && observed === "block") {
    return `Legitimate lab traffic was blocked. Availability or false-positive risk for ${row.category || "this case"}.`;
  }
  if (expected === "throttle" && observed === "allow") {
    return "Rate-limit policy did not trigger within the configured lab measurement.";
  }
  return `Declared ${expected} does not match observed ${observed}.`;
}
