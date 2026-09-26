/**
 * Compare intended allow/deny policy with observed reachability.
 */

import { securityResult } from "../evidence.mjs";

export function evaluateSegmentation({ intended = [], observed = [] } = {}) {
  const rows = [];
  for (const item of (intended || []).slice(0, 80)) {
    const key = rowKey(item);
    const got = (observed || []).find((o) => rowKey(o) === key);
    const expected = normalizeAction(item.expected || item.action);
    const seen = got
      ? normalizeAction(got.observed || got.reachable === true ? "allow" : "deny")
      : "unobserved";
    const match = seen !== "unobserved" && expected === seen;
    rows.push({
      source: item.source,
      destination: item.destination,
      port: item.port,
      protocol: item.protocol || "tcp",
      expected,
      observed: seen,
      match,
    });
  }
  const mismatches = rows.filter((r) => !r.match);
  return securityResult({
    tool: "security_segmentation_test",
    observed: {
      matrix: rows,
      compared: rows.length,
      matched: rows.filter((r) => r.match).length,
    },
    expected: rows.map(
      (r) => `${r.source} → ${r.destination}:${r.port} ${r.expected}`,
    ),
    mismatch: mismatches.map(
      (r) =>
        `${r.source} → ${r.destination}:${r.port} expected ${r.expected}, observed ${r.observed}`,
    ),
    possibleCause: mismatches.length
      ? [
          "A missing allow rule, an unexpected allow, or a test that never reached the destination.",
        ]
      : [],
    recommendedRemediation: mismatches.length
      ? [
          "For each mismatch, inspect the matching firewall rule and repeat the port test from the same source.",
        ]
      : [],
    unverified: rows.some((r) => r.observed === "unobserved")
      ? ["Some intended flows were not tested."]
      : [],
  });
}

function normalizeAction(value) {
  const v = String(value || "").toLowerCase();
  if (v === "block" || v === "closed" || v === "false") return "deny";
  if (v === "open" || v === "true" || v === "reachable") return "allow";
  if (v === "allow" || v === "deny" || v === "unobserved") return v;
  return v || "unobserved";
}

function rowKey(row = {}) {
  return [
    String(row.source || "").toLowerCase(),
    String(row.destination || "").toLowerCase(),
    String(row.port ?? ""),
    String(row.protocol || "tcp").toLowerCase(),
  ].join("|");
}
