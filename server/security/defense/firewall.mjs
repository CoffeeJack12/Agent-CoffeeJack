/**
 * Windows Firewall policy evaluation. Fail-closed. Read-only by default.
 */

import { securityResult } from "../evidence.mjs";

const MAX_RULES = 400;

export function normalizePorts(value) {
  if (value == null || value === "" || value === "any" || value === "*")
    return { any: true, ports: [] };
  const ports = [];
  for (const part of String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 64)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a >= 1 && b <= 65535 && a <= b) ports.push({ from: a, to: b });
      continue;
    }
    const n = Number(part);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) ports.push({ from: n, to: n });
  }
  return { any: false, ports };
}

export function portMatches(spec, port) {
  if (!spec || spec.any) return true;
  if (!Number.isInteger(port)) return false;
  return spec.ports.some((p) => port >= p.from && port <= p.to);
}

export function normalizeRule(rule = {}, index = 0) {
  const action = String(rule.action || "allow").toLowerCase();
  return {
    id: String(rule.id || rule.name || `rule-${index}`),
    name: String(rule.name || rule.id || `rule-${index}`),
    enabled: rule.enabled !== false,
    direction: String(rule.direction || "inbound").toLowerCase(),
    action: action === "block" ? "deny" : action,
    profiles: (rule.profiles || ["domain", "private", "public"]).map((p) =>
      String(p).toLowerCase(),
    ),
    protocol: String(rule.protocol || "any").toLowerCase(),
    localPorts: normalizePorts(rule.localPorts ?? rule.localPort),
    remotePorts: normalizePorts(rule.remotePorts ?? rule.remotePort),
    program: rule.program || null,
    service: rule.service || null,
    interfaces: (rule.interfaces || ["any"]).map((i) => String(i).toLowerCase()),
    profileScope: rule.profiles || ["domain", "private", "public"],
  };
}

export function normalizePolicy(policy = {}) {
  const profiles = {};
  for (const name of ["domain", "private", "public"]) {
    const src = policy.profiles?.[name] || {};
    profiles[name] = {
      name,
      enabled: src.enabled !== false,
      inbound: String(src.inbound || src.defaultInbound || "block").toLowerCase(),
      outbound: String(src.outbound || src.defaultOutbound || "allow").toLowerCase(),
      logging: {
        allowed: Boolean(src.logging?.allowed),
        blocked: Boolean(src.logging?.blocked ?? src.logging?.dropped),
        file: src.logging?.file || null,
      },
    };
  }
  return {
    profiles,
    activeProfiles: (policy.activeProfiles || ["private"]).map((p) =>
      String(p).toLowerCase(),
    ),
    rules: (policy.rules || []).slice(0, MAX_RULES).map(normalizeRule),
  };
}

export function ruleMatches(rule, query = {}) {
  if (!rule.enabled) return false;
  if (query.direction && rule.direction !== String(query.direction).toLowerCase())
    return false;
  if (
    query.profile &&
    !rule.profiles.includes("any") &&
    !rule.profiles.includes(String(query.profile).toLowerCase())
  )
    return false;
  if (
    query.protocol &&
    rule.protocol !== "any" &&
    rule.protocol !== String(query.protocol).toLowerCase()
  )
    return false;
  if (query.port != null && !portMatches(rule.localPorts, Number(query.port)))
    return false;
  if (
    query.program &&
    rule.program &&
    String(rule.program).toLowerCase() !== String(query.program).toLowerCase()
  )
    return false;
  return true;
}

export function evaluateFirewallQuery(policyInput, query = {}) {
  const policy = normalizePolicy(policyInput);
  const profileName = String(query.profile || policy.activeProfiles[0] || "private");
  const profile = policy.profiles[profileName] || policy.profiles.private;
  const matches = policy.rules.filter((r) =>
    ruleMatches(r, { ...query, profile: profileName }),
  );
  const allows = matches.filter((r) => r.action === "allow");
  const denies = matches.filter((r) => r.action === "deny");
  const defaultAction =
    String(query.direction || "inbound") === "outbound"
      ? profile.outbound
      : profile.inbound;
  let observed;
  if (denies.length && allows.length) observed = "conflict";
  else if (denies.length) observed = "deny";
  else if (allows.length) observed = "allow";
  else observed = defaultAction === "block" ? "deny" : defaultAction;
  return {
    policy,
    profileName,
    profile,
    matches,
    allows,
    denies,
    defaultAction,
    observed,
    conflict: observed === "conflict",
  };
}

export function inspectFirewallPolicy(policyInput, query = {}) {
  const ev = evaluateFirewallQuery(policyInput, query);
  const mismatch = [];
  if (ev.conflict) {
    mismatch.push(
      `Conflicting allow and deny rules match ${query.direction || "inbound"} port ${query.port ?? "any"} on ${ev.profileName}.`,
    );
  }
  return securityResult({
    tool: "security_firewall_inspect",
    observed: {
      activeProfiles: ev.policy.activeProfiles,
      profiles: ev.policy.profiles,
      ruleCount: ev.policy.rules.length,
      enabledRules: ev.policy.rules.filter((r) => r.enabled).length,
      disabledRules: ev.policy.rules.filter((r) => !r.enabled).length,
      matchingRules: ev.matches.map(summarizeRule),
      allowRules: ev.allows.map(summarizeRule),
      denyRules: ev.denies.map(summarizeRule),
      logging: Object.fromEntries(
        Object.entries(ev.policy.profiles).map(([k, v]) => [k, v.logging]),
      ),
      decision: ev.observed,
    },
    expected: query.expected ? [query.expected] : [],
    mismatch,
    possibleCause: ev.conflict
      ? ["More than one enabled rule matches the same traffic tuple."]
      : [],
    recommendedRemediation: ev.conflict
      ? [
          "Disable or narrow the overlapping rule, then re-test the same port and profile.",
        ]
      : [],
    assessment: [
      ev.conflict
        ? "allow and deny rules both match this traffic"
        : `${ev.observed} observed for the queried traffic`,
    ],
    unverified: [
      "This is a static policy evaluation. Live packets were not sent.",
    ],
  });
}

export function listFirewallRules(policyInput, query = {}) {
  const policy = normalizePolicy(policyInput);
  const rules = policy.rules.filter((r) => {
    if (query.enabledOnly && !r.enabled) return false;
    if (query.direction && r.direction !== String(query.direction).toLowerCase())
      return false;
    if (query.action) {
      const action = String(query.action).toLowerCase() === "block" ? "deny" : String(query.action).toLowerCase();
      if (r.action !== action) return false;
    }
    if (query.profile && !r.profiles.includes(String(query.profile).toLowerCase()))
      return false;
    return true;
  });
  return securityResult({
    tool: "security_firewall_rules",
    observed: {
      action: "list",
      count: rules.length,
      rules: rules.slice(0, 200).map(summarizeRule),
    },
    unverified: ["Rule list is a snapshot of the supplied or retrieved policy."],
  });
}

function summarizeRule(rule) {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    direction: rule.direction,
    action: rule.action,
    profiles: rule.profiles,
    protocol: rule.protocol,
    localPorts: rule.localPorts,
    program: rule.program,
    service: rule.service,
    interfaces: rule.interfaces,
  };
}

export function createFirewallRuleStore({
  initial = { rules: [], profiles: {}, activeProfiles: ["private"] },
  runner,
} = {}) {
  let current = normalizePolicy(initial);
  const backups = [];

  function snapshot() {
    return JSON.parse(JSON.stringify(current));
  }

  return {
    snapshot,
    backups: () => backups.map((b) => ({ id: b.id, at: b.at })),
    async inspect(query) {
      if (typeof runner === "function") {
        const live = await runner({ action: "inspect" });
        current = normalizePolicy(live);
      }
      return inspectFirewallPolicy(current, query);
    },
    async list(query) {
      if (typeof runner === "function") {
        const live = await runner({ action: "list" });
        current = normalizePolicy(live);
      }
      return listFirewallRules(current, query);
    },
    backup(label = "manual") {
      const id = `fw-${Date.now()}-${backups.length + 1}`;
      backups.push({ id, at: new Date().toISOString(), label, policy: snapshot() });
      return id;
    },
    async mutate({ action, rule, backupId, verify } = {}) {
      const verb = String(action || "").toLowerCase();
      if (!["add", "remove", "enable", "disable", "rollback"].includes(verb)) {
        return securityResult({
          tool: "security_firewall_rules",
          error: "Unknown firewall rule action.",
          observed: { action: verb },
        });
      }
      const before = snapshot();
      let backup = null;
      if (verb === "rollback") {
        const found =
          backups.find((b) => b.id === backupId) || backups.at(-1);
        if (!found) {
          return securityResult({
            tool: "security_firewall_rules",
            error: "No firewall backup to restore.",
            observed: { action: "rollback" },
          });
        }
        current = normalizePolicy(found.policy);
        backup = found.id;
      } else {
        backup = this.backup(verb);
        if (verb === "add") {
          current.rules = [...current.rules, normalizeRule(rule, current.rules.length)];
        } else if (verb === "remove") {
          current.rules = current.rules.filter(
            (r) => r.id !== rule?.id && r.name !== rule?.name,
          );
        } else if (verb === "enable" || verb === "disable") {
          current.rules = current.rules.map((r) =>
            r.id === rule?.id || r.name === rule?.name
              ? { ...r, enabled: verb === "enable" }
              : r,
          );
        }
      }
      if (typeof runner === "function") {
        await runner({ action: verb, before, after: snapshot(), rule });
      }
      const after = snapshot();
      const verification = typeof verify === "function" ? await verify(after) : null;
      return securityResult({
        tool: "security_firewall_rules",
        observed: {
          action: verb,
          backupId: backup,
          before: { rules: before.rules.map(summarizeRule) },
          after: { rules: after.rules.map(summarizeRule) },
          verification,
          rolledBack: verb === "rollback",
        },
        expected: ["Policy change applies only after Owner approval."],
        recommendedRemediation:
          verb === "rollback"
            ? []
            : ["Use action=rollback with the backup id to restore the prior rules."],
        unverified: verification
          ? []
          : ["Connectivity was not re-tested unless a verify callback was supplied."],
      });
    },
  };
}
