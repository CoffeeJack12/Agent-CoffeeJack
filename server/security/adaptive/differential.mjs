/**
 * Differential comparison of two recorded lab cases.
 */

const COMPARE_FIELDS = [
  "method",
  "path",
  "query",
  "headers",
  "contentType",
  "bodyKind",
  "bodySize",
  "httpVersion",
  "hostKind",
  "ipVersion",
  "tls",
  "sni",
  "port",
  "protocol",
  "mtu",
];

function changedInputs(a = {}, b = {}) {
  const changes = [];
  for (const field of COMPARE_FIELDS) {
    const left = JSON.stringify(a[field] ?? null);
    const right = JSON.stringify(b[field] ?? null);
    if (left !== right) changes.push({ field, a: a[field] ?? null, b: b[field] ?? null });
  }
  return changes;
}

export function compareCases(caseA = {}, caseB = {}) {
  const reqA = caseA.request || {};
  const reqB = caseB.request || {};
  const changes = changedInputs(reqA, reqB);
  const decisionsDiffer =
    (caseA.observed_decision || caseA.decision) !== (caseB.observed_decision || caseB.decision);
  const statusDiffer = (caseA.status ?? null) !== (caseB.status ?? null);
  const latencyA = caseA.latency ?? caseA.latencyMs ?? null;
  const latencyB = caseB.latency ?? caseB.latencyMs ?? null;
  return {
    case_a: caseA.case_id || caseA.test_id || null,
    case_b: caseB.case_id || caseB.test_id || null,
    changed_input: changes,
    policy_difference: decisionsDiffer,
    comparison: {
      allowed_blocked: {
        a: caseA.observed_decision || null,
        b: caseB.observed_decision || null,
      },
      response_code: { a: caseA.status ?? null, b: caseB.status ?? null },
      latency: { a: latencyA, b: latencyB },
      headers: {
        a: caseA.response_metadata?.headers || {},
        b: caseB.response_metadata?.headers || {},
      },
      tcp: {
        a: caseA.response_metadata?.tcp || null,
        b: caseB.response_metadata?.tcp || null,
      },
      tls: {
        a: caseA.response_metadata?.tls || null,
        b: caseB.response_metadata?.tls || null,
      },
      ids_waf_alert: {
        a: Boolean(caseA.telemetry?.waf?.matched || caseA.telemetry?.ids?.matched),
        b: Boolean(caseB.telemetry?.waf?.matched || caseB.telemetry?.ids?.matched),
      },
    },
    highlight:
      decisionsDiffer && changes.length === 1
        ? `Policy difference caused by ${changes[0].field}`
        : decisionsDiffer
          ? `Policy difference with ${changes.length} changed input field(s)`
          : statusDiffer
            ? "Response code differs; observed decision did not"
            : "No policy difference",
  };
}

export function highlightPairs(cases = []) {
  const pairs = [];
  for (let i = 0; i < cases.length; i += 1) {
    for (let j = i + 1; j < cases.length; j += 1) {
      const diff = compareCases(cases[i], cases[j]);
      if (diff.policy_difference && diff.changed_input.length && diff.changed_input.length <= 3) {
        pairs.push(diff);
      }
    }
  }
  return pairs.slice(0, 40);
}
