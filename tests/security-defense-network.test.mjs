/**
 * Defensive firewall / network-security assessment.
 * Synthetic policy and mocked connectors only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Tools } from "../server/tools.mjs";
import {
  authorize,
  applyLegacyOwnerAutoApprove,
  shouldSkipLegacyAutoApprove,
  toolCapability,
} from "../server/permissions.mjs";
import { buildCapabilityRegistry, capabilityPolicy } from "../server/capabilities.mjs";
import { DEFAULT_PREFERENCES, MODES } from "../server/preferences.mjs";
import { resolveTurnContext, filterToolsForTurn } from "../server/conversation-intent.mjs";
import { classifySecurityIntent, createSecurityToolkit } from "../server/security/index.mjs";
import {
  inspectFirewallPolicy,
  evaluateFirewallQuery,
} from "../server/security/defense/firewall.mjs";
import { testPorts, classifyConnectFailure } from "../server/security/defense/connect.mjs";
import { testDns } from "../server/security/defense/route.mjs";
import { inspectCertificatePem, inspectTlsHandshake } from "../server/security/defense/tls.mjs";
import { evaluateSegmentation } from "../server/security/defense/segmentation.mjs";
import { runWafTests } from "../server/security/defense/waf.mjs";
import { validateIds } from "../server/security/defense/ids.mjs";
import { TEST_CERT_PEM } from "./helpers/tls-fixtures.mjs";

const owner = { id: "owner-1", role: "owner", status: "active" };
const trusted = { id: "trusted-1", role: "trusted", status: "active" };
const standard = { id: "std-1", role: "standard", status: "active", email_verified: 1 };
const guest = { id: "guest-1", role: "guest", status: "active" };

const policy = {
  activeProfiles: ["private"],
  profiles: {
    domain: { enabled: true, inbound: "block", outbound: "allow" },
    private: { enabled: true, inbound: "block", outbound: "allow", logging: { blocked: true } },
    public: { enabled: true, inbound: "block", outbound: "block" },
  },
  rules: [
    {
      id: "allow-web",
      name: "Allow HTTP",
      enabled: true,
      direction: "inbound",
      action: "allow",
      profiles: ["private"],
      protocol: "tcp",
      localPorts: "80",
    },
    {
      id: "deny-rdp",
      name: "Block RDP",
      enabled: true,
      direction: "inbound",
      action: "deny",
      profiles: ["private", "public"],
      protocol: "tcp",
      localPorts: "3389",
    },
    {
      id: "conflict-allow",
      name: "Allow 22",
      enabled: true,
      direction: "inbound",
      action: "allow",
      profiles: ["private"],
      protocol: "tcp",
      localPorts: "22",
    },
    {
      id: "conflict-deny",
      name: "Deny 22",
      enabled: true,
      direction: "inbound",
      action: "deny",
      profiles: ["private"],
      protocol: "tcp",
      localPorts: "22",
    },
    {
      id: "public-only",
      name: "Public 8080",
      enabled: true,
      direction: "inbound",
      action: "allow",
      profiles: ["public"],
      protocol: "tcp",
      localPorts: "8080",
    },
  ],
};

function approveFor(user, autoApprove = false) {
  return async (name, args) => {
    const capability = toolCapability(name, args);
    let decision = authorize({ user, capability, action: name });
    decision = applyLegacyOwnerAutoApprove(decision, user, autoApprove, name, args);
    if (decision.decision === "allow") return;
    if (decision.decision === "deny")
      throw new Error(`Permission denied: ${decision.reason}`);
    throw new Error("APPROVAL_REQUIRED");
  };
}

test("allow rule detection", () => {
  const ev = evaluateFirewallQuery(policy, {
    profile: "private",
    direction: "inbound",
    port: 80,
    protocol: "tcp",
  });
  assert.equal(ev.observed, "allow");
  assert.ok(ev.allows.some((r) => r.id === "allow-web"));
});

test("deny rule detection", () => {
  const ev = evaluateFirewallQuery(policy, {
    profile: "private",
    direction: "inbound",
    port: 3389,
    protocol: "tcp",
  });
  assert.equal(ev.observed, "deny");
  assert.ok(ev.denies.some((r) => r.id === "deny-rdp"));
});

test("conflicting rules", () => {
  const result = inspectFirewallPolicy(policy, {
    profile: "private",
    direction: "inbound",
    port: 22,
    protocol: "tcp",
  });
  assert.equal(result.observed.decision, "conflict");
  assert.ok(result.mismatch.some((m) => /Conflicting/i.test(m)));
  assert.ok(result.possibleCause.length);
  assert.ok(result.recommendedRemediation.length);
});

test("profile-specific rules", () => {
  const privateEv = evaluateFirewallQuery(policy, {
    profile: "private",
    direction: "inbound",
    port: 8080,
    protocol: "tcp",
  });
  assert.equal(privateEv.observed, "deny");
  assert.equal(privateEv.matches.length, 0);
  const publicEv = evaluateFirewallQuery(policy, {
    profile: "public",
    direction: "inbound",
    port: 8080,
    protocol: "tcp",
  });
  assert.equal(publicEv.observed, "allow");
});

test("port reachability and timeout handling", async () => {
  const result = await testPorts({
    host: "10.0.0.8",
    ports: [22, 80],
    connect: async ({ port }) => {
      if (port === 22) return { reachable: true };
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    },
  });
  const byPort = Object.fromEntries(result.observed.results.map((r) => [r.port, r]));
  assert.equal(byPort[22].reachable, true);
  assert.equal(byPort[80].timeout, true);
  assert.equal(byPort[80].failureClass, "unverified");
  assert.equal(classifyConnectFailure({ code: "ECONNREFUSED" }), "remote");
  assert.equal(classifyConnectFailure({ code: "EADDRNOTAVAIL" }), "local");
});

test("DNS failure", async () => {
  const result = await testDns({
    name: "missing.coffeejack.test",
    lookup: async () => {
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    },
  });
  assert.equal(result.observed.resolved, false);
  assert.ok(result.mismatch.some((m) => /DNS lookup failed/.test(m)));
  assert.ok(result.possibleCause.some((c) => /not found/i.test(c)));
});

test("TLS certificate parsing", () => {
  const leaf = inspectCertificatePem(TEST_CERT_PEM, {
    host: "test.coffeejack.local",
  });
  assert.match(leaf.subject, /test.coffeejack.local/);
  assert.equal(leaf.expired, false);
  assert.equal(leaf.hostnameOk, true);
  const wrong = inspectTlsHandshake({
    host: "other.example",
    certificates: [TEST_CERT_PEM],
    protocol: "TLSv1.3",
    cipher: "TLS_AES_128_GCM_SHA256",
  });
  assert.ok(wrong.mismatch.some((m) => /Hostname/.test(m)));
  assert.equal(wrong.observed.sni, "other.example");
  assert.equal(wrong.observed.protocol, "TLSv1.3");
});

test("segmentation matrix", () => {
  const result = evaluateSegmentation({
    intended: [
      { source: "lan", destination: "web", port: 443, expected: "allow" },
      { source: "lan", destination: "db", port: 5432, expected: "deny" },
    ],
    observed: [
      { source: "lan", destination: "web", port: 443, reachable: true },
      { source: "lan", destination: "db", port: 5432, reachable: true },
    ],
  });
  assert.equal(result.observed.matrix.length, 2);
  assert.equal(result.observed.matched, 1);
  assert.ok(result.mismatch.some((m) => /5432/.test(m) && /expected deny/.test(m)));
});

test("WAF benign test flow", async () => {
  const denied = await runWafTests({
    target: "https://evil.example",
    allowlist: ["lab.coffeejack.local"],
    http: async () => ({ status: 200 }),
  });
  assert.match(denied.error, /authorized allowlist/);

  const statuses = [];
  const ok = await runWafTests({
    target: "https://lab.coffeejack.local",
    allowlist: ["lab.coffeejack.local"],
    http: async (req) => {
      statuses.push(`${req.method} ${req.url}`);
      return { status: req.method === "OPTIONS" ? 204 : 200, bytes: 12 };
    },
  });
  assert.equal(ok.observed.authorized, true);
  assert.equal(ok.observed.evasion, false);
  assert.ok(ok.observed.results.some((r) => r.id === "trailing-slash"));
  assert.ok(ok.observed.results.some((r) => r.id === "rate-limit"));
  assert.ok(statuses.some((s) => s.startsWith("HEAD ")));

  const evade = await runWafTests({
    target: "https://lab.coffeejack.local",
    allowlist: ["lab.coffeejack.local"],
    tests: [{ id: "bad", method: "GET", path: "/../etc/passwd" }],
    http: async () => ({ status: 200 }),
  });
  assert.match(evade.error, /evasion|exploit/i);
});

test("IDS synthetic validation", async () => {
  const custom = await validateIds({ testId: "CUSTOM-ATTACK" });
  assert.match(custom.error, /catalogued synthetic/);

  const missed = await validateIds({
    testId: "CJ-SYNTH-DNS-CANARY",
    send: async () => ({ sent: true, evidence: "query sent" }),
    detector: async () => false,
  });
  assert.equal(missed.observed.observedDetection, false);
  assert.ok(missed.mismatch.length);

  const hit = await validateIds({
    testId: "CJ-SYNTH-HTTP-CANARY",
    target: "https://lab.coffeejack.local",
    allowlist: ["lab.coffeejack.local"],
    send: async () => ({ sent: true, evidence: "canary 200" }),
    detector: async () => true,
    clock: () => "2026-09-26T00:00:00.000Z",
  });
  assert.equal(hit.observed.observedDetection, true);
  assert.equal(hit.observed.timestamp, "2026-09-26T00:00:00.000Z");
  assert.ok(hit.expected[0].includes("HTTP canary"));
});

test("Standard denied; Guest denied; Trusted inspect needs permission", () => {
  assert.equal(toolCapability("security_firewall_inspect"), "security_inspect");
  assert.equal(
    toolCapability("security_firewall_rules", { action: "list" }),
    "security_inspect",
  );
  assert.equal(
    toolCapability("security_firewall_rules", { action: "add" }),
    "security_firewall_modify",
  );
  assert.equal(
    authorize({ user: standard, capability: "security_inspect" }).decision,
    "deny",
  );
  assert.equal(
    authorize({ user: guest, capability: "security_inspect" }).decision,
    "deny",
  );
  assert.equal(
    authorize({ user: trusted, capability: "security_inspect" }).decision,
    "require_approval",
  );
  assert.equal(
    authorize({ user: standard, capability: "security_firewall_modify" }).decision,
    "deny",
  );
  assert.equal(
    authorize({ user: trusted, capability: "security_firewall_modify" }).decision,
    "deny",
  );
});

test("Owner rule change approval required and is not auto-approved", async () => {
  assert.equal(
    authorize({ user: owner, capability: "security_firewall_modify" }).decision,
    "require_approval",
  );
  assert.equal(
    shouldSkipLegacyAutoApprove("security_firewall_rules", { action: "add" }),
    true,
  );
  assert.equal(
    applyLegacyOwnerAutoApprove(
      authorize({ user: owner, capability: "security_firewall_modify" }),
      owner,
      true,
      "security_firewall_rules",
      { action: "add" },
    ).decision,
    "require_approval",
  );
  const tools = new Tools({
    root: "/tmp",
    workspace: "/tmp",
    approve: approveFor(owner, true),
    securityUser: owner,
  });
  await assert.rejects(
    () =>
      tools.execute(
        "security_firewall_rules",
        { action: "add", rule: { name: "tmp", localPorts: "9" } },
        new AbortController().signal,
      ),
    /APPROVAL_REQUIRED/,
  );
  await assert.rejects(
    () =>
      new Tools({
        root: "/tmp",
        workspace: "/tmp",
        approve: approveFor(standard),
      }).execute(
        "security_firewall_inspect",
        {},
        new AbortController().signal,
      ),
    /Permission denied/,
  );
});

test("rollback restores prior rules", async () => {
  const kit = createSecurityToolkit({
    workspace: "/tmp",
    user: owner,
    adapters: { firewallPolicy: policy },
  });
  const before = await kit.execute("security_firewall_rules", { action: "list" });
  const count = before.observed.count;
  const added = await kit.execute("security_firewall_rules", {
    action: "add",
    rule: { id: "temp", name: "temp", localPorts: "9999", action: "allow" },
  });
  assert.ok(added.observed.backupId);
  assert.ok(added.observed.after.rules.some((r) => r.id === "temp"));
  const restored = await kit.execute("security_firewall_rules", {
    action: "rollback",
    backupId: added.observed.backupId,
  });
  assert.equal(restored.observed.rolledBack, true);
  const after = await kit.execute("security_firewall_rules", { action: "list" });
  assert.equal(after.observed.count, count);
  assert.ok(!after.observed.rules.some((r) => r.id === "temp"));
});

test("toolkit wires port/tls/segmentation/service map", async () => {
  const kit = createSecurityToolkit({
    workspace: "/tmp",
    user: owner,
    adapters: {
      connect: async () => ({ reachable: true }),
      lookup: async () => ["10.0.0.2"],
      authorizedTargets: ["lab.coffeejack.local"],
      http: async () => ({ status: 200, bytes: 1 }),
      listeners: async () => [
        { protocol: "tcp", localPort: 443, pid: 8, state: "Listen" },
      ],
    },
  });
  const ports = await kit.execute("security_port_test", { host: "10.0.0.2", port: 443 });
  assert.equal(ports.observed.results[0].reachable, true);
  const tls = await kit.execute("security_tls_inspect", {
    host: "test.coffeejack.local",
    pem: TEST_CERT_PEM,
  });
  assert.equal(tls.observed.leaf.hostnameOk, true);
  const seg = await kit.execute("security_segmentation_test", {
    intended: [{ source: "a", destination: "b", port: 1, expected: "allow" }],
    observed: [{ source: "a", destination: "b", port: 1, observed: "allow" }],
  });
  assert.equal(seg.observed.matched, 1);
  const map = await kit.execute("security_service_map", {
    processes: [{ pid: 8, name: "nginx" }],
    tls: [{ port: 443, protocol: "TLSv1.3" }],
  });
  assert.equal(map.observed.services[0].identification, "https");
  const inspect = await kit.execute("security_firewall_inspect", { policy });
  assert.equal(inspect.observed.profiles.private.logging.blocked, true);
});

test("chat routes firewall and TLS requests to dedicated tools", () => {
  const cases = [
    ["inspect the firewall", "security_firewall_inspect"],
    ["show firewall rules", "security_firewall_rules"],
    ["is port 443 open", "security_port_test"],
    ["traceroute to gateway", "security_route_trace"],
    ["dns lookup for intranet.local", "security_dns_test"],
    ["inspect the certificate on this host", "security_tls_inspect"],
    ["segmentation matrix from lan to db", "security_segmentation_test"],
    ["run a waf test", "security_waf_test"],
    ["ids validation canary", "security_ids_validation"],
    ["what is listening on this host", "security_service_map"],
  ];
  for (const [text, tool] of cases) {
    const intent = classifySecurityIntent(text);
    assert.equal(intent?.tool, tool, text);
    const turn = resolveTurnContext(text);
    assert.equal(turn.taskHint, tool, text);
    const filtered = filterToolsForTurn(
      [{ function: { name: "terminal" } }, { function: { name: tool } }],
      turn,
    );
    assert.ok(!filtered.some((d) => d.function.name === "terminal"), text);
  }
});

test("Hacker mode exposes network_defense", () => {
  const hacker = capabilityPolicy({ ...DEFAULT_PREFERENCES, mode: "hacker" });
  assert.ok(hacker.allows("security_firewall_inspect"));
  assert.ok(hacker.allows("security_waf_test"));
  const registry = buildCapabilityRegistry({
    preferences: { ...DEFAULT_PREFERENCES, mode: "hacker" },
    platform: "win32",
  });
  assert.equal(registry.find((c) => c.id === "network_defense").enabled, true);
  assert.ok(MODES.hacker.packs.includes("network_defense"));
});
