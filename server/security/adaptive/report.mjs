/**
 * Sanitized professional validation report.
 * No secrets, packet payloads, or raw bodies.
 */

const SECRET = /(?:password|authorization|cookie|set-cookie|api[_-]?key|access_token|refresh_token)/i;

export function sanitizeReportValue(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (SECRET.test(value)) return "[redacted]";
    return value.slice(0, 400);
  }
  if (Array.isArray(value)) return value.slice(0, 40).map(sanitizeReportValue);
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (["body", "payload", "packets", "raw", "bytes", "hex"].includes(key)) continue;
      if (SECRET.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = sanitizeReportValue(item);
    }
    return out;
  }
  return value;
}

export function buildValidationReport(run = {}, extras = {}) {
  const cases = run.cases || [];
  const findings = extras.findings || run.findings || [];
  const target = extras.target || {};
  const gaps = findings.filter((row) => row.gap);
  const summary = [
    `Adaptive validation ${run.status || "complete"} against ${target.name || target.host || run.target_id || "an authorized target"}.`,
    `${cases.length} recorded case(s), ${gaps.length} policy gap(s).`,
    run.cancelled ? "The run was stopped by the Owner." : null,
  ]
    .filter(Boolean)
    .join(" ");
  return sanitizeReportValue({
    title: "CoffeeJack Adaptive Security Validation Report",
    executive_summary: summary,
    target: {
      target_id: run.target_id,
      name: target.name || null,
      host: target.host || null,
      environment: target.environment || null,
    },
    declared_authorization: target.authorization_note || run.authorization_note || null,
    controls_tested: unique(cases.map((row) => row.control || row.category).filter(Boolean)),
    baseline: cases.find((row) => row.phase === "baseline") || null,
    tests_performed: cases.map((row) => ({
      test_id: row.test_id || row.case_id,
      phase: row.phase,
      category: row.category,
      expected: row.expected_decision,
      observed: row.observed_decision,
      status: row.status ?? null,
      latency: row.latency ?? null,
    })),
    observed_policy: summarizeObserved(cases),
    policy_gaps: gaps,
    evidence: cases.slice(0, 40).map((row) => ({
      test_id: row.test_id || row.case_id,
      category: row.category,
      expected: row.expected_decision,
      observed: row.observed_decision,
    })),
    reproduction_steps: reproduction(cases, target),
    suggested_remediation: gaps.map((gap) => gap.impact),
    retest_status: run.status === "complete" && !gaps.length ? "clean" : "needs_retest",
    secrets_omitted: true,
    payloads_omitted: true,
  });
}

function unique(values) {
  return [...new Set(values)];
}

function summarizeObserved(cases) {
  const counts = {};
  for (const row of cases) {
    const key = row.observed_decision || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function reproduction(cases, target) {
  const interesting = cases.filter((row) => row.expected_decision !== row.observed_decision).slice(0, 8);
  if (!interesting.length) {
    return ["Re-run the same target_id with the stored baseline request. No policy gaps were recorded."];
  }
  return interesting.map(
    (row) =>
      `Against authorized target ${target.target_id || row.target_id}, replay recorded case ${row.case_id || row.test_id} (${row.category}): expected ${row.expected_decision}, observed ${row.observed_decision}.`,
  );
}
