/**
 * Expected decisions come only from Owner-provided policy,
 * imported firewall rules, or explicitly configured expectations.
 * Never invent expected policy.
 */

export const DECISIONS = Object.freeze([
  "allow",
  "block",
  "throttle",
  "error",
  "timeout",
  "crash",
  "unspecified",
]);

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function matchField(expected, actual) {
  if (expected == null || expected === "" || expected === "*") return true;
  return norm(expected) === norm(actual);
}

export function normalizeExpectation(row = {}) {
  const decision = norm(row.decision || row.expected_decision || row.expected);
  if (!["allow", "block", "throttle"].includes(decision)) return null;
  return {
    id: row.id || null,
    control: row.control || row.source || "owner_policy",
    decision,
    match: {
      method: row.match?.method || row.method || null,
      path: row.match?.path || row.path || null,
      contentType: row.match?.contentType || row.contentType || row.content_type || null,
      category: row.match?.category || row.category || null,
      port: row.match?.port ?? row.port ?? null,
      protocol: row.match?.protocol || row.protocol || null,
      source: row.match?.source || row.sourceHost || null,
      destination: row.match?.destination || row.destination || null,
    },
    note: row.note || row.authorization_note || null,
  };
}

export function normalizeLabPolicy(input = {}) {
  const expectations = asList(input.expectations || input.expected || input.rules)
    .map(normalizeExpectation)
    .filter(Boolean);
  const firewallRules = asList(input.firewallRules || input.firewall_rules).map((rule) => ({
    source: rule.source || rule.src || null,
    destination: rule.destination || rule.dest || rule.dst || null,
    protocol: norm(rule.protocol || "tcp") || "tcp",
    port: rule.port ?? rule.dport ?? null,
    decision: ["allow", "block"].includes(norm(rule.decision || rule.action))
      ? norm(rule.decision || rule.action)
      : null,
    profile: rule.profile || null,
  })).filter((rule) => rule.decision);
  return {
    source: input.source || (expectations.length || firewallRules.length ? "owner" : "none"),
    notes: input.notes || null,
    expectations,
    firewallRules,
    invented: false,
  };
}

export function lookupExpected(request = {}, policyInput = {}) {
  const policy = policyInput.expectations || policyInput.firewallRules
    ? policyInput
    : normalizeLabPolicy(policyInput);
  for (const rule of policy.expectations || []) {
    const m = rule.match || {};
    if (!matchField(m.method, request.method)) continue;
    if (!matchField(m.path, request.path)) continue;
    if (!matchField(m.contentType, request.contentType || request.headers?.["content-type"])) continue;
    if (!matchField(m.category, request.category || request.family)) continue;
    if (m.port != null && Number(m.port) !== Number(request.port)) continue;
    if (!matchField(m.protocol, request.protocol)) continue;
    return {
      decision: rule.decision,
      source: rule.control,
      note: rule.note,
      invented: false,
    };
  }
  for (const rule of policy.firewallRules || []) {
    if (!matchField(rule.protocol, request.protocol || "tcp")) continue;
    if (rule.port != null && Number(rule.port) !== Number(request.port)) continue;
    if (!matchField(rule.destination, request.host || request.destination)) continue;
    if (!matchField(rule.source, request.source)) continue;
    return {
      decision: rule.decision,
      source: "imported_firewall",
      note: null,
      invented: false,
    };
  }
  return {
    decision: "unspecified",
    source: null,
    note: "No Owner-provided expectation matches this case. Expected policy was not invented.",
    invented: false,
  };
}

export function mayCallBypass(expected, observed) {
  return expected === "block" && observed === "allow";
}
