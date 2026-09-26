/**
 * Adaptive Security Validation Lab — simulated controls and fixtures only.
 * No malware or exploit payloads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { Tools } from "../server/tools.mjs";
import {
  authorize,
  toolCapability,
  approvalConsequence,
} from "../server/permissions.mjs";
import {
  buildCapabilityRegistry,
  capabilityPolicy,
} from "../server/capabilities.mjs";
import { DEFAULT_PREFERENCES, MODES, PACKS } from "../server/preferences.mjs";
import { resolveTurnContext, filterToolsForTurn } from "../server/conversation-intent.mjs";
import { sanitizeForRemote } from "../server/privacy.mjs";
import { createUser, createSession } from "../server/users.mjs";
import { classifySecurityIntent, SECURITY_TOOLS } from "../server/security/index.mjs";
import {
  createTargetRegistry,
  normalizeLabPolicy,
  lookupExpected,
  generateHttpMutations,
  generateNetworkMutations,
  generateRelatedFamily,
  generateSafeFuzzCases,
  clampBudgets,
  createLessonStore,
  correlateTelemetry,
  compareCases,
  detectPolicyGaps,
  runRateLimitTest,
  buildFirewallMatrix,
  buildValidationReport,
  detectLabEnvironment,
  createLabToolkit,
} from "../server/security/adaptive/index.mjs";
import {
  parseWindowsFirewallLog,
  parseSuricataEve,
  parseZeekConn,
  parseModSecurityLog,
  parseReverseProxyAccess,
} from "../server/security/adaptive/telemetry.mjs";
import { RATE_HARD } from "../server/security/adaptive/rate-limit.mjs";
import { HARD_BUDGETS } from "../server/security/adaptive/scorer.mjs";
import { looksLikeExploitPayload } from "../server/security/adaptive/mutations.mjs";
import { slimSecurityForRemote } from "../server/security/evidence.mjs";

const owner = { id: "owner-1", role: "owner", status: "active" };
const trusted = { id: "trusted-1", role: "trusted", status: "active" };
const standard = { id: "std-1", role: "standard", status: "active", email_verified: 1 };
const guest = { id: "guest-1", role: "guest", status: "active" };

function approveFor(user) {
  return async (name, args) => {
    const capability = toolCapability(name, args);
    const decision = authorize({
      user,
      capability,
      action: name,
      context: { labAction: args?.action },
    });
    if (decision.decision === "allow") return;
    if (decision.decision === "deny")
      throw new Error(`Permission denied: ${decision.reason}`);
    throw new Error("APPROVAL_REQUIRED");
  };
}

function labTarget(overrides = {}) {
  return {
    name: "Juice lab",
    host: "127.0.0.1",
    ports: [8080, 8443],
    protocols: ["http", "https"],
    environment: "localhost",
    authorization_note: "Owner-controlled local Juice Shop lab",
    ...overrides,
  };
}

function mockSend(control = {}) {
  const state = { count: 0, threshold: control.threshold || 3 };
  return async (req) => {
    state.count += 1;
    const pathName = req.path || "/";
    const method = req.method || "GET";
    const ct = String(req.headers?.["content-type"] || req.contentType || "").toLowerCase();
    if (req.kind === "rate_limit" && state.count > state.threshold) {
      return { status: 429, decision: "throttle" };
    }
    if (req.kind === "rate_limit_recovery") return { status: 200 };
    if (req.fuzz === "truncated_line") {
      return { code: "ECONNRESET", afterMalformed: true, crash: true };
    }
    if (method === "POST" && ct.includes("json")) {
      return { status: 403, headers: { "x-waf": "json-blocked" } };
    }
    if (method === "POST" && ct.includes("form")) {
      return { status: 200, headers: { "x-waf": "form-ok" } };
    }
    if (pathName === "/health") return { status: 403 };
    if (pathName === "/health/" || pathName.includes("/./")) return { status: 200 };
    if (method === "PUT") return { status: 403 };
    if (req.headers && Object.keys(req.headers).some((k) => k === "ACCEPT")) {
      return { status: 403, headers: { "x-waf": "header-case" } };
    }
    if (req.ipVersion === "ipv6") return { status: 403, tcp: { family: "ipv6" } };
    if (req.hostKind === "direct_ip") return { status: 200, tcp: { via: "ip" } };
    if (req.tls === false) return { status: 200, tls: null };
    if (req.sni && req.sni.startsWith("lab.") && req.sni !== `lab.${control.sni || "127.0.0.1"}`) {
      return { status: 403, tls: { sni: req.sni, authorized: false } };
    }
    if (req.httpVersion === "1.0") return { status: 505 };
    return {
      status: 200,
      headers: { server: "lab-fixture" },
      tls: req.tls ? { protocol: "TLSv1.3", sni: req.sni || null, authorized: true } : null,
      tcp: { family: req.ipVersion || "ipv4" },
    };
  };
}

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-lab-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

test("target registry records Owner fields and rejects unregistered destinations", async (t) => {
  const dir = await tempDir(t);
  const registry = createTargetRegistry({ dataDirectory: dir });
  await registry.load();
  const added = await registry.add(labTarget(), owner);
  assert.ok(added.target_id);
  assert.equal(added.host, "127.0.0.1");
  assert.equal(added.authorization_note.includes("Juice"), true);
  assert.equal(added.enabled, true);
  assert.equal(added.created_by, owner.id);
  assert.deepEqual(added.ports, [8080, 8443]);
  const listed = registry.list();
  assert.equal(listed.length, 1);
  assert.throws(() => registry.require("missing"), /Unknown target_id/);
  assert.throws(
    () => registry.assertDestination(added.target_id, "evil.example"),
    /unrelated hosts/,
  );
  assert.throws(() => registry.rejectArbitrary("8.8.8.8"), /Arbitrary destinations/);
  await assert.rejects(() => registry.add(labTarget({ host: "10.0.0.5" }), trusted), /Only Owner/);
  await assert.rejects(() => registry.remove(added.target_id, standard), /Only Owner/);
});

test("arbitrary unregistered target is rejected by the lab tool", async () => {
  const kit = createLabToolkit({ user: owner, adapters: { send: mockSend() } });
  await assert.rejects(
    () =>
      kit.execute("security_lab", {
        action: "run",
        host: "evil.example",
        target: "https://evil.example",
      }),
    /Arbitrary destinations|target_id/,
  );
});

test("baseline generation and expected vs observed comparison", async () => {
  const kit = createLabToolkit({
    user: owner,
    adapters: { send: mockSend() },
  });
  const target = await kit.registry.add(labTarget(), owner);
  const policy = normalizeLabPolicy({
    expectations: [
      { method: "GET", path: "/", decision: "allow" },
      { method: "GET", path: "/health", decision: "block" },
    ],
  });
  assert.equal(lookupExpected({ method: "GET", path: "/" }, policy).decision, "allow");
  assert.equal(lookupExpected({ method: "GET", path: "/health" }, policy).decision, "block");
  assert.equal(lookupExpected({ method: "TRACE", path: "/nope" }, policy).decision, "unspecified");
  assert.equal(lookupExpected({ method: "TRACE", path: "/nope" }, policy).invented, false);

  const result = await kit.execute("security_lab", {
    action: "run",
    target_id: target.target_id,
    policy,
    baseline: { method: "GET", path: "/", headers: { accept: "text/plain" } },
    maxRounds: 2,
    maxCasesPerRound: 12,
    maxCasesPerRun: 30,
  });
  const baseline = result.observed.cases.find((row) => row.phase === "baseline");
  assert.equal(baseline.observed_decision, "allow");
  assert.equal(baseline.expected_decision, "allow");
  assert.equal(baseline.status, 200);
  assert.ok(baseline.latency != null);
  const health = result.observed.cases.find((row) => row.request?.path === "/health");
  if (health) {
    assert.equal(health.observed_decision, "block");
  }
});

test("HTTP mutation generation covers required categories", () => {
  const target = {
    target_id: "t1",
    host: "127.0.0.1",
    ports: [80],
    protocols: ["http"],
  };
  const cases = generateHttpMutations(
    { method: "GET", path: "/health", query: { b: "2", a: "1" }, headers: { accept: "text/plain", "x-lab": "1" } },
    { target, budget: 25 },
  );
  const cats = new Set(cases.map((row) => row.category));
  for (const needed of [
    "http_method",
    "header_order",
    "duplicate_header",
    "header_case",
    "url_encoding",
    "path_normalization",
    "query_order",
    "content_type",
    "body_size",
    "http_version",
  ]) {
    assert.ok(cats.has(needed), needed);
  }
  assert.ok(cases.every((row) => row.recorded && row.target_id === "t1"));
  assert.equal(looksLikeExploitPayload("<script>"), true);
  assert.equal(looksLikeExploitPayload("GET /health"), false);
});

test("path, header, method, and TLS metadata differences are observed", async () => {
  const kit = createLabToolkit({ user: owner, adapters: { send: mockSend() } });
  const target = await kit.registry.add(labTarget({ host: "127.0.0.1" }), owner);
  const policy = {
    expectations: [
      { method: "GET", path: "/health", decision: "block" },
      { method: "PUT", path: "/", decision: "block" },
    ],
  };
  const result = await kit.execute("security_lab", {
    action: "run",
    target_id: target.target_id,
    policy,
    baseline: { method: "GET", path: "/health", headers: { accept: "text/plain" } },
    maxRounds: 3,
    maxCasesPerRound: 20,
    maxCasesPerRun: 50,
  });
  const cases = result.observed.cases;
  const pathNorm = cases.filter((row) => row.category === "path_normalization");
  assert.ok(pathNorm.length);
  const slash = cases.find((row) => row.request?.path === "/health/");
  const raw = cases.find((row) => row.request?.path === "/health" && row.phase !== "baseline") || cases.find((row) => row.phase === "baseline");
  if (slash && raw) {
    const diff = compareCases(raw, slash);
    assert.equal(diff.policy_difference, true);
    assert.ok(diff.changed_input.some((c) => c.field === "path"));
  }
  const methods = cases.filter((row) => row.category === "http_method");
  assert.ok(methods.some((row) => row.request.method === "PUT" && row.observed_decision === "block"));
  const headerCase = cases.find((row) => row.category === "header_case");
  assert.ok(headerCase);
  const tls = cases.filter((row) => row.category === "tls_vs_plaintext" || row.category === "sni");
  assert.ok(tls.length);
  const tlsMeta = cases.find((row) => row.response_metadata?.tls);
  assert.ok(tlsMeta);
});

test("adaptive next-test selection, budgets, and cancellation", async () => {
  const kit = createLabToolkit({ user: owner, adapters: { send: mockSend() } });
  const target = await kit.registry.add(labTarget(), owner);
  const policy = {
    expectations: [{ method: "GET", path: "/health", decision: "block" }],
  };
  const result = await kit.execute("security_lab", {
    action: "run",
    target_id: target.target_id,
    policy,
    baseline: { method: "GET", path: "/health" },
    maxRounds: 3,
    maxCasesPerRound: 6,
    maxCasesPerRun: 16,
  });
  assert.ok(result.observed.case_count <= 16);
  assert.ok(result.observed.rounds <= 3);
  assert.ok(result.observed.cases.some((row) => String(row.phase).startsWith("round-")));

  const hard = clampBudgets({ maxRounds: 99, maxCasesPerRound: 99, maxCasesPerRun: 999 });
  assert.deepEqual(hard, HARD_BUDGETS);

  const tight = createLabToolkit({ user: owner, adapters: { send: mockSend() } });
  const t2 = await tight.registry.add(labTarget({ name: "tight" }), owner);
  const bounded = await tight.execute("security_lab", {
    action: "run",
    target_id: t2.target_id,
    policy: { expectations: [{ method: "GET", path: "/", decision: "allow" }] },
    baseline: { method: "GET", path: "/" },
    maxRounds: 1,
    maxCasesPerRound: 2,
    maxCasesPerRun: 3,
  });
  assert.ok(bounded.observed.case_count <= 3);

  const aborting = createLabToolkit({ user: owner, adapters: { send: async () => {
    await new Promise((r) => setTimeout(r, 20));
    return { status: 200 };
  } } });
  const t3 = await aborting.registry.add(labTarget({ name: "stop" }), owner);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 5);
  const stopped = await aborting.execute("security_lab", {
    action: "run",
    target_id: t3.target_id,
    policy: {},
    baseline: { method: "GET", path: "/" },
    maxCasesPerRun: 200,
  }, ac.signal);
  assert.equal(stopped.observed.cancelled, true);
  const halt = await aborting.execute("security_lab", { action: "stop" });
  assert.ok("stopped" in halt.observed);
});

test("learning persists, is target-scoped, and never authorizes another target", async (t) => {
  const dir = await tempDir(t);
  const lessons = createLessonStore({ dataDirectory: dir });
  await lessons.load();
  const a = await lessons.add({
    control: "WAF",
    target_id: "target-a",
    observation: "POST JSON rejected while equivalent form-urlencoded request was accepted",
    confidence: "high",
    evidence: [{ test_id: "1" }],
  });
  assert.equal(a.target_id, "target-a");
  assert.equal(lessons.list({ targetId: "target-b" }).length, 0);
  assert.equal(lessons.authorizes("target-a", "target-b"), false);
  const kit = createLabToolkit({
    dataDirectory: dir,
    user: owner,
    adapters: { send: mockSend(), lessons },
  });
  const other = await kit.registry.add(labTarget({ name: "other", host: "10.0.0.8", environment: "rfc1918" }), owner);
  const gen = kit.lessons.forGeneration(other.target_id);
  assert.equal(gen.every((row) => row.target_id === other.target_id), true);
  assert.ok(!gen.some((row) => row.target_id === "target-a"));
});

test("policy gap detection only calls bypass when policy expected block", () => {
  const findings = detectPolicyGaps([
    {
      case_id: "1",
      target_id: "t",
      category: "content_type",
      expected_decision: "block",
      observed_decision: "allow",
      status: 200,
    },
    {
      case_id: "2",
      target_id: "t",
      category: "http_method",
      expected_decision: "unspecified",
      observed_decision: "allow",
    },
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].expected, /block/);
  assert.match(findings[0].observed, /allow/);
  assert.match(findings[0].gap, /content_type/);
  assert.ok(findings[0].evidence.length);
  assert.ok(findings[0].impact);
  assert.match(String(findings[0].bypass), /blocked/);
  const noBypass = detectPolicyGaps([
    {
      case_id: "3",
      expected_decision: "allow",
      observed_decision: "block",
      category: "http_method",
    },
  ]);
  assert.equal(noBypass[0].bypass, false);
});

test("Windows Firewall, mocked WAF, and mocked IDS telemetry parse without fabrication", () => {
  const fw = parseWindowsFirewallLog(`#Version: 1.5
2026-09-26 01:00:00 DROP TCP 10.0.0.2 10.0.0.8 54321 80 60`);
  assert.equal(fw.available, true);
  assert.equal(fw.rows[0].action, "DROP");
  assert.equal(fw.rows[0].dst, "10.0.0.8");

  const ids = parseSuricataEve(
    JSON.stringify({
      timestamp: "2026-09-26T01:00:00Z",
      event_type: "alert",
      dest_ip: "10.0.0.8",
      dest_port: 80,
      alert: { action: "blocked", signature: "lab-canary" },
      http: { http_method: "GET", url: "/" },
    }),
  );
  assert.equal(ids.rows[0].signature, "lab-canary");

  const zeek = parseZeekConn("1000\tuid1\t10.0.0.2\t1234\t10.0.0.8\t80\ttcp\thttp");
  assert.equal(zeek.rows[0].dst, "10.0.0.8");

  const waf = parseModSecurityLog('ModSecurity: Access denied with code 403 (id "942100") [uri "/"]');
  assert.equal(waf.rows[0].action, "block");

  const proxy = parseReverseProxyAccess(
    '127.0.0.1 - - [26/Sep/2026:01:00:00 +0000] "GET / HTTP/1.1" 200 12',
  );
  assert.equal(proxy.rows[0].status, 200);

  const none = correlateTelemetry({ request: { host: "10.0.0.8", path: "/", port: 80 } });
  assert.equal(none.available, false);
  assert.equal(none.fabricated, false);

  const correlated = correlateTelemetry({
    request: { host: "10.0.0.8", path: "/", port: 80, method: "GET" },
    windowsFirewall: "2026-09-26 01:00:00 DROP TCP 10.0.0.2 10.0.0.8 54321 80 60",
    suricata: JSON.stringify({
      dest_ip: "10.0.0.8",
      dest_port: 80,
      alert: { action: "blocked", signature: "lab-canary" },
      http: { url: "/", http_method: "GET" },
    }),
    modsecurity: 'ModSecurity: Access denied with code 403 (id "942100")',
    proxy: '127.0.0.1 - - [26/Sep/2026:01:00:00 +0000] "GET / HTTP/1.1" 403 12',
  });
  assert.equal(correlated.fabricated, false);
  assert.equal(correlated.firewall.matched, true);
  assert.equal(correlated.ids.matched, true);
});

test("differential result generation highlights the changed input", () => {
  const diff = compareCases(
    {
      case_id: "a",
      request: { method: "POST", path: "/", contentType: "application/json" },
      observed_decision: "block",
      status: 403,
    },
    {
      case_id: "b",
      request: { method: "POST", path: "/", contentType: "application/x-www-form-urlencoded" },
      observed_decision: "allow",
      status: 200,
    },
  );
  assert.equal(diff.policy_difference, true);
  assert.equal(diff.changed_input.length, 1);
  assert.equal(diff.changed_input[0].field, "contentType");
  assert.match(diff.highlight, /contentType/);
});

test("rate-limit tests stay hard-bounded", async () => {
  const plan = await runRateLimitTest({
    target: { target_id: "t", host: "127.0.0.1" },
    expectedThreshold: 2,
    maxRequestRate: 500,
    durationMs: 400,
    send: mockSend({ threshold: 2 }),
  });
  assert.ok(plan.plan.maxRequestRate <= RATE_HARD.maxRequestRate);
  assert.equal(plan.plan.maxRequestRate, RATE_HARD.maxRequestRate);
  assert.ok(plan.plan.durationMs <= 400);
  assert.ok(plan.plan.planned <= RATE_HARD.maxTotalRequests);
  assert.equal(plan.flood, false);
  assert.equal(plan.bounded, true);
  assert.equal(plan.when_throttling_begins, 3);
  assert.equal(plan.status_code, 429);
});

test("Security Lab Owner access, Trusted permission, Standard/Guest denied", async () => {
  assert.equal(toolCapability("security_lab"), "security_lab");
  assert.equal(authorize({ user: owner, capability: "security_lab" }).decision, "allow");
  assert.equal(
    authorize({
      user: trusted,
      capability: "security_lab",
      context: { labAction: "run" },
    }).decision,
    "require_approval",
  );
  assert.equal(
    authorize({
      user: trusted,
      capability: "security_lab",
      context: { labAction: "targets_add" },
    }).decision,
    "deny",
  );
  assert.equal(authorize({ user: standard, capability: "security_lab" }).decision, "deny");
  assert.equal(authorize({ user: guest, capability: "security_lab" }).decision, "deny");
  assert.match(approvalConsequence("security_lab", { target_id: "t" }), /target_id/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-lab-tools-"));
  const ownerTools = new Tools({
    root: dir,
    workspace: dir,
    dataDirectory: path.join(dir, ".local"),
    approve: approveFor(owner),
    securityUser: owner,
    securityAdapters: { send: mockSend() },
  });
  const listed = await ownerTools.execute(
    "security_lab",
    { action: "targets_list" },
    new AbortController().signal,
  );
  assert.equal(listed.tool, "security_lab");

  const trustedTools = new Tools({
    root: dir,
    workspace: dir,
    approve: approveFor(trusted),
    securityUser: trusted,
  });
  await assert.rejects(
    () =>
      trustedTools.execute(
        "security_lab",
        { action: "targets_add", target: labTarget() },
        new AbortController().signal,
      ),
    /Permission denied|Only Owner/,
  );
  await assert.rejects(
    () =>
      trustedTools.execute(
        "security_lab",
        { action: "run", target_id: "x" },
        new AbortController().signal,
      ),
    /APPROVAL_REQUIRED|Permission denied/,
  );

  const standardTools = new Tools({
    root: dir,
    workspace: dir,
    approve: approveFor(standard),
    securityUser: standard,
  });
  await assert.rejects(
    () =>
      standardTools.execute(
        "security_lab",
        { action: "availability" },
        new AbortController().signal,
      ),
    /Permission denied/,
  );
  const guestTools = new Tools({
    root: dir,
    workspace: dir,
    approve: approveFor(guest),
    securityUser: guest,
  });
  await assert.rejects(
    () =>
      guestTools.execute(
        "security_lab",
        { action: "lessons" },
        new AbortController().signal,
      ),
    /Permission denied/,
  );
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

test("sanitized reporting omits secrets and payloads", () => {
  const report = buildValidationReport(
    {
      run_id: "r1",
      target_id: "t1",
      status: "complete",
      authorization_note: "local lab",
      cases: [
        {
          case_id: "c1",
          phase: "baseline",
          category: "baseline",
          expected_decision: "allow",
          observed_decision: "allow",
          request: { body: "password=supersecret", headers: { authorization: "Bearer abc" } },
        },
        {
          case_id: "c2",
          category: "content_type",
          expected_decision: "block",
          observed_decision: "allow",
          target_id: "t1",
        },
      ],
    },
    {
      target: { target_id: "t1", name: "lab", host: "127.0.0.1", authorization_note: "Owner lab" },
      findings: detectPolicyGaps([
        {
          case_id: "c2",
          category: "content_type",
          expected_decision: "block",
          observed_decision: "allow",
          target_id: "t1",
        },
      ]),
    },
  );
  const json = JSON.stringify(report);
  assert.match(report.executive_summary, /Adaptive validation/);
  assert.ok(report.declared_authorization);
  assert.ok(report.tests_performed.length);
  assert.ok(report.policy_gaps.length);
  assert.ok(report.reproduction_steps.length);
  assert.equal(report.secrets_omitted, true);
  assert.doesNotMatch(json, /supersecret/);
  assert.doesNotMatch(json, /Bearer abc/);
  const slim = slimSecurityForRemote({
    tool: "security_lab",
    observed: {
      cases: [{ request: { body: "secret-body", payload: "pkt" }, observed_decision: "allow" }],
      report,
    },
  });
  assert.equal(JSON.stringify(slim).includes("secret-body"), false);
  const remote = sanitizeForRemote(JSON.stringify({
    tool: "security_lab",
    observed: { body: "raw-body", cases: [] },
    _attribution: { local: true },
  }));
  assert.ok(remote.sensitive);
});

test("firewall differential matrix and lab environment detect-only", () => {
  const matrix = buildFirewallMatrix({
    intended: [
      { source: "10.0.0.2", destination: "10.0.0.8", protocol: "tcp", port: 80, expected: "block" },
    ],
    observed: [
      { source: "10.0.0.2", destination: "10.0.0.8", protocol: "tcp", port: 80, observed: "allow" },
    ],
  });
  assert.equal(matrix.rows[0].result, "mismatch");
  const env = detectLabEnvironment({ exists: () => false });
  assert.equal(env.requiredAtStartup, false);
  assert.equal(env.runtimes.docker.autoInstall, false);
  assert.equal(env.adapters.owasp_juice_shop.requiredAtStartup, false);
});

test("related family selection after unexpected allow and safe fuzz has no exploit chain", () => {
  const target = { target_id: "t", host: "127.0.0.1", ports: [80], protocols: ["http"] };
  const seed = generateHttpMutations({ method: "GET", path: "/health" }, { target, budget: 25 })
    .find((row) => row.category === "path_normalization");
  const family = generateRelatedFamily(seed, { target, budget: 8 });
  assert.ok(family.length);
  assert.ok(family.every((row) => ["path_normalization", "url_encoding"].includes(row.category)));
  const fuzz = generateSafeFuzzCases({ method: "GET", path: "/" }, { target, budget: 8 });
  assert.ok(fuzz.length);
  assert.ok(fuzz.every((row) => !looksLikeExploitPayload(JSON.stringify(row))));
  const net = generateNetworkMutations({ method: "GET", path: "/" }, { target, budget: 12 });
  assert.ok(net.some((row) => row.category === "ipv4_ipv6"));
  assert.ok(net.some((row) => row.category === "dns_vs_ip"));
  assert.ok(net.some((row) => row.category === "mtu"));
});

test("intent, packs, and terminal stay hidden on lab turns", () => {
  assert.equal(classifySecurityIntent("open the security lab").tool, "security_lab");
  assert.ok(PACKS.security_lab);
  assert.ok(MODES.hacker.packs.includes("security_lab"));
  const hacker = capabilityPolicy({ ...DEFAULT_PREFERENCES, mode: "hacker" });
  assert.ok(hacker.allows("security_lab"));
  const registry = buildCapabilityRegistry({
    preferences: { ...DEFAULT_PREFERENCES, mode: "auto" },
    platform: "linux",
  });
  assert.equal(registry.find((c) => c.id === "security_lab").enabled, true);
  const gaming = buildCapabilityRegistry({
    preferences: { ...DEFAULT_PREFERENCES },
    gaming: true,
    platform: "linux",
  });
  assert.equal(gaming.find((c) => c.id === "security_lab").enabled, false);
  const turn = resolveTurnContext("run adaptive validation on the authorized target");
  assert.equal(turn.taskHint, "security_lab");
  const filtered = filterToolsForTurn(
    [{ function: { name: "terminal" } }, { function: { name: "security_lab" } }],
    turn,
  );
  assert.equal(filtered.some((d) => d.function.name === "terminal"), false);
  assert.ok(SECURITY_TOOLS.includes("security_lab"));
});

test("Owner API can use Security Lab; Standard and Guest cannot", async (t) => {
  const dir = await tempDir(t);
  const fake = {
    models: async () => [{ name: "qwen3:8b" }],
    inspect: async () => ({ capabilities: ["tools"] }),
    prepare: async () => ({ alreadyLoaded: true, unloaded: [] }),
    unload: async () => [],
    chat: async ({ onToken }) => {
      onToken("ok");
      return { role: "assistant", content: "ok", tokens: 1 };
    },
  };
  const app = await createApp({
    dataDirectory: dir,
    root: "/workspace",
    remoteAccess: null,
    ollama: fake,
  });
  app.store.set("autoGaming", false);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections?.();
    await app.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const ownerRes = await fetch(base + "/api/security-lab", {
    headers: { "X-CoffeeJack-Token": app.token },
  });
  assert.equal(ownerRes.status, 200);
  const snap = await ownerRes.json();
  assert.ok(Array.isArray(snap.targets));
  assert.ok(snap.availability);

  const add = await fetch(base + "/api/security-lab/targets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": app.token,
    },
    body: JSON.stringify(labTarget()),
  });
  assert.equal(add.status, 200);

  const std = createUser(app.store, {
    displayName: "Standard",
    role: "standard",
  });
  const stdSession = createSession(app.store, std.id, { source: "local" });
  const denied = await fetch(base + "/api/security-lab", {
    headers: { "X-CoffeeJack-Token": stdSession.token },
  });
  assert.equal(denied.status, 403);

  const gst = createUser(app.store, { displayName: "Guest", role: "guest" });
  const gstSession = createSession(app.store, gst.id, { source: "local" });
  const guestDenied = await fetch(base + "/api/security-lab", {
    headers: { "X-CoffeeJack-Token": gstSession.token },
  });
  assert.equal(guestDenied.status, 403);

  const html = await (await fetch(base + "/")).text();
  assert.match(html, /id="labView"/);
  assert.match(html, /navSecurityLab/);
  assert.match(html, /Authorized Targets|lab.targets/);
});
