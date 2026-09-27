/**
 * Reverse-engineering toolkit — synthetic fixtures and mocks only.
 * No live malware samples.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { resolveLocalOwner } from "../server/users.mjs";
import { Tools } from "../server/tools.mjs";
import {
  authorize,
  applyLegacyOwnerAutoApprove,
  shouldSkipLegacyAutoApprove,
  toolCapability,
} from "../server/permissions.mjs";
import {
  buildCapabilityRegistry,
  capabilityPolicy,
} from "../server/capabilities.mjs";
import { DEFAULT_PREFERENCES, MODES } from "../server/preferences.mjs";
import {
  resolveTurnContext,
  filterToolsForTurn,
} from "../server/conversation-intent.mjs";
import { resolveEffectiveMode } from "../server/auto-mode.mjs";
import { sanitizeForRemote } from "../server/privacy.mjs";
import { eventDetailForStorage } from "../server/agent.mjs";
import {
  createSecurityToolkit,
  classifySecurityIntent,
  SECURITY_TOOLS,
  inspectBinaryBuffer,
  extractStrings,
  hashesOf,
} from "../server/security/index.mjs";
import { parsePe, PeParseError, detectPackerIndicators } from "../server/security/pe.mjs";
import { shannonEntropy } from "../server/security/entropy.mjs";
import { compareBuffers } from "../server/security/binary.mjs";
import {
  securityResult,
  slimSecurityForRemote,
  assertNoForbiddenAbsolutes,
} from "../server/security/evidence.mjs";
import { detectSecurityTools } from "../server/security/detect.mjs";
import {
  minimalPe32,
  minimalPe32Plus,
  peWithImports,
  peWithExports,
  highEntropyPe,
  overlayPe,
  packerNamedPe,
  truncatedPe,
  mzOnly,
  badSignaturePe,
  sectionOverflowPe,
  tinyNonPe,
  stringsFixture,
  manyStringsFixture,
  TIMESTAMP,
} from "./helpers/pe-fixtures.mjs";

const owner = { id: "owner-1", role: "owner", status: "active" };
const trusted = { id: "trusted-1", role: "trusted", status: "active" };
const standard = { id: "std-1", role: "standard", status: "active", email_verified: 1 };
const guest = { id: "guest-1", role: "guest", status: "active" };

async function tempWorkspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-re-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return { dir, store };
}

function approveFor(user, autoApprove = false) {
  return async (name, args) => {
    const capability = toolCapability(name, args);
    let decision = authorize({ user, capability, action: name });
    decision = applyLegacyOwnerAutoApprove(decision, user, autoApprove, name);
    if (decision.decision === "allow") return;
    if (decision.decision === "deny")
      throw new Error(`Permission denied: ${decision.reason}`);
    throw new Error("APPROVAL_REQUIRED");
  };
}

test("1-2 PE32 and PE32+ parse", () => {
  const pe32 = parsePe(minimalPe32());
  assert.equal(pe32.format, "PE32");
  assert.equal(pe32.architecture, "I386");
  assert.equal(pe32.entryPoint, 0x1000);
  assert.equal(pe32.imageBase, "0x400000");
  assert.equal(pe32.timeDateStamp, TIMESTAMP);
  assert.ok(pe32.compileTimestamp.startsWith("2020-09-13"));
  assert.ok(pe32.sections.some((s) => s.name === ".text"));
  assert.equal(pe32.sections[0].permissions.execute, true);
  assert.equal(pe32.sections[0].permissions.read, true);

  const pe64 = parsePe(minimalPe32Plus());
  assert.equal(pe64.format, "PE32+");
  assert.equal(pe64.architecture, "AMD64");
  assert.equal(pe64.entryPoint, 0x1000);
  assert.equal(pe64.imageBase, "0x140000000");
});

test("3-4 malformed PE and bounds violations fail closed", () => {
  assert.throws(() => parsePe(tinyNonPe()), PeParseError);
  assert.throws(() => parsePe(truncatedPe()), PeParseError);
  assert.throws(() => parsePe(mzOnly()), PeParseError);
  assert.throws(() => parsePe(badSignaturePe()), /Missing PE signature/);
  assert.throws(() => parsePe(sectionOverflowPe()), (err) => {
    assert.equal(err.code, "PE_BOUNDS");
    return true;
  });
  const inspected = inspectBinaryBuffer(truncatedPe(), { fileName: "bad.exe" });
  assert.ok(inspected.error);
  assert.equal(inspected.observed.format, "MZ/unparsed");
  assert.ok(inspected.unverified.some((u) => /PE parse failed closed/i.test(u)));
});

test("5-8 sections, imports, exports, entry point", () => {
  const sections = parsePe(minimalPe32()).sections;
  assert.ok(sections.length >= 1);
  assert.equal(typeof sections[0].virtualAddress, "number");
  assert.equal(typeof sections[0].permissions.read, "boolean");

  const imports = parsePe(peWithImports());
  assert.equal(imports.entryPoint, 0x1000);
  assert.ok(imports.imports.some((i) => i.dll === "KERNEL32.dll"));
  const apis = imports.imports.flatMap((i) => i.apis.map((a) => a.name));
  assert.ok(apis.includes("ExitProcess"));
  assert.ok(apis.includes("LoadLibraryA"));

  const exports = parsePe(peWithExports());
  assert.equal(exports.exports.dllName, "demo.dll");
  assert.ok(exports.exports.names.some((n) => n.name === "Foo"));
  assert.ok(exports.exports.names.some((n) => n.name === "Bar"));
});

test("9-10 entropy and overlay", () => {
  assert.equal(shannonEntropy(Buffer.alloc(32)), 0);
  const high = highEntropyPe();
  const pe = inspectBinaryBuffer(high, { fileName: "rand.exe" });
  assert.ok(pe.observed.sections.some((s) => s.highEntropy));
  assert.ok(pe.assessment.some((a) => /high entropy observed/i.test(a)));
  assert.ok(!pe.assessment.some((a) => /\bpacked\b/i.test(a)));

  const over = inspectBinaryBuffer(overlayPe(), { fileName: "over.exe" });
  assert.equal(over.observed.overlay.present, true);
  assert.ok(over.observed.overlay.size > 0);
  assert.ok(over.assessment.some((a) => /overlay data present/i.test(a)));
});

test("11-13 strings ASCII, UTF-16, categorization", () => {
  const extracted = extractStrings(stringsFixture(), { minLength: 4 });
  const values = extracted.items.map((i) => i.value);
  assert.ok(values.includes("HelloWorld"));
  assert.ok(values.some((v) => v.includes("WideStringURL")));
  assert.ok(extracted.categories.urls.some((u) => /example.com/.test(u)));
  assert.ok(extracted.categories.ips.includes("10.20.30.40"));
  assert.ok(extracted.categories.domains.some((d) => /evil.example.com/.test(d)));
  assert.ok(extracted.categories.registry.some((r) => /HKLM/.test(r)));
  assert.ok(extracted.categories.paths.some((p) => /Windows\\System32/.test(p)));
  assert.ok(extracted.categories.dlls.some((d) => /kernel32.dll/i.test(d)));
  assert.ok(extracted.categories.apis.some((a) => /CreateProcessW/.test(a)));
  assert.ok(extracted.categories.shellFragments.some((s) => /powershell/i.test(s)));
  assert.match(extracted.note, /observations, not instructions/);
});

test("14-16 SHA-256 and binary comparison", () => {
  const abc = Buffer.from("abc");
  assert.equal(
    hashesOf(abc).sha256,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const same = inspectBinaryBuffer(minimalPe32(), { fileName: "a.exe" });
  const digest = createHash("sha256").update(minimalPe32()).digest("hex");
  assert.equal(same.observed.sha256, digest);

  const a = Buffer.from("patch-v1");
  const b = Buffer.from("patch-v2");
  const eq = compareBuffers(a, a, { labels: ["left.exe", "right.exe"] });
  assert.equal(eq.observed.byteEqual, true);
  assert.equal(eq.observed.hashChanged, false);
  const diff = compareBuffers(a, b, { labels: ["left.exe", "right.exe"] });
  assert.equal(diff.observed.byteEqual, false);
  assert.equal(diff.observed.hashChanged, true);
  assert.equal(diff.observed.sizeChanged, false);
});

test("17 optional tools report unavailable without installing", () => {
  const detected = detectSecurityTools({ exists: () => false });
  assert.equal(detected.ghidra, false);
  assert.equal(detected.rizin, false);
  assert.equal(detected.yara, false);
  assert.equal(detected.pktmon, false);
  assert.equal(detected.tshark, false);
});

test("18-20 mocked Ghidra, Rizin, YARA", async (t) => {
  const { dir } = await tempWorkspace(t);
  await fs.writeFile(path.join(dir, "sample.exe"), peWithImports());
  await fs.writeFile(path.join(dir, "rules.yar"), "rule dummy { condition: true }");
  const kit = createSecurityToolkit({
    workspace: dir,
    dataDirectory: path.join(dir, ".local"),
    user: owner,
    exists: (p) =>
      /analyzeHeadless|ghidra|rizin|rz-bin|yara/i.test(String(p)),
    adapters: {
      ghidraRun: async () => ({
        functions: [{ name: "entry", address: "0x1000" }],
        symbols: [{ name: "entry" }],
        imports: ["KERNEL32.dll"],
        disassembly: "0x1000: ret",
        decompilation: "void entry() { return; }",
      }),
      rizinRun: async () => ({
        functions: [{ name: "fcn.1000" }],
        disassembly: "ret",
        decompilation: "int fcn(void) { return 0; }",
      }),
      yaraRun: async () => ({
        matches: [
          {
            rule: "SyntheticDemo",
            tags: ["test"],
            meta: { author: "fixture" },
            offsets: [0],
          },
        ],
      }),
    },
  });
  const dis = await kit.execute("security_disassemble", { path: "sample.exe" });
  assert.equal(dis.available, true);
  assert.equal(dis.observed.originalBinaryModified, false);
  assert.ok(dis.observed.functions.some((f) => f.name === "entry"));

  const dec = await kit.execute("security_decompile", {
    path: "sample.exe",
    function: "entry",
  });
  assert.match(String(dec.observed.decompilation || dis.observed.decompilation || ""), /entry|return/);

  const yara = await kit.execute("security_yara_scan", {
    path: "sample.exe",
    rulesPath: "rules.yar",
  });
  assert.equal(yara.available, true);
  assert.equal(yara.observed.uploaded, false);
  assert.equal(yara.observed.matches[0].rule, "SyntheticDemo");
  assert.ok(yara.assessment.some((a) => /YARA rule SyntheticDemo matched/.test(a)));
  assert.ok(yara.unverified.some((u) => /not a malware confirmation/.test(u)));

  const rizinKit = createSecurityToolkit({
    workspace: dir,
    dataDirectory: path.join(dir, ".local"),
    user: owner,
    exists: (p) => /rizin|rz-bin/i.test(String(p)),
    adapters: {
      rizinRun: async () => ({
        functions: [{ name: "fcn.1000" }],
        symbols: [{ name: "sym.imp.ExitProcess" }],
        imports: ["KERNEL32.dll"],
        disassembly: "0x1000: ret",
        decompilation: "int fcn(void) { return 0; }",
      }),
    },
  });
  const rz = await rizinKit.execute("security_disassemble", { path: "sample.exe" });
  assert.equal(rz.available, true);
  assert.ok(rz.observed.functions.some((f) => f.name === "fcn.1000"));
  assert.equal(rz.observed.originalBinaryModified, false);
});

test("optional Ghidra/Rizin/YARA unavailable is honest", async (t) => {
  const { dir } = await tempWorkspace(t);
  await fs.writeFile(path.join(dir, "sample.exe"), minimalPe32());
  const kit = createSecurityToolkit({
    workspace: dir,
    dataDirectory: path.join(dir, ".local"),
    user: owner,
    exists: () => false,
  });
  const dis = await kit.execute("security_disassemble", { path: "sample.exe" });
  assert.equal(dis.available, false);
  assert.match(dis.error, /No Ghidra|not installed|not detected/i);
  const yara = await kit.execute("security_yara_scan", { path: "sample.exe" });
  assert.equal(yara.available, false);
  assert.match(yara.error, /YARA is not installed/);
  assert.ok(yara.unverified.some((u) => /not silently installed/.test(u)));
});

test("21-22 mocked process and network snapshots", async () => {
  const kit = createSecurityToolkit({
    workspace: os.tmpdir(),
    user: owner,
    adapters: {
      processRunner: async ({ pid, name }) => {
        if (name === "dup.exe")
          return [
            { pid: 11, name: "dup.exe", path: "C:\\\\a\\\\dup.exe" },
            { pid: 12, name: "dup.exe", path: "C:\\\\b\\\\dup.exe" },
          ];
        return [
          {
            pid: pid || 4242,
            name: name || "notepad.exe",
            path: "C:\\\\Windows\\\\System32\\\\notepad.exe",
            parentPid: 4,
            commandLine: "notepad.exe",
            architecture: "AMD64",
            startTime: "2026-01-01T00:00:00",
            memoryBytes: 1111,
            signatureStatus: "Valid",
            modules: [
              { name: "ntdll.dll", path: "C:\\\\Windows\\\\System32\\\\ntdll.dll" },
            ],
            ports: [{ protocol: "tcp", localPort: 1234, state: "Listen" }],
          },
        ];
      },
      networkRunner: async () => ({
        interfaces: [{ InterfaceAlias: "Ethernet", IPAddress: "10.0.0.2" }],
        connections: [
          {
            protocol: "tcp",
            localAddress: "10.0.0.2",
            localPort: 80,
            remoteAddress: "1.2.3.4",
            remotePort: 443,
            state: "Established",
            pid: 99,
            processName: "svc.exe",
          },
          {
            protocol: "tcp",
            localAddress: "0.0.0.0",
            localPort: 445,
            state: "Listen",
            pid: 4,
            processName: "System",
          },
          {
            protocol: "udp",
            localAddress: "0.0.0.0",
            localPort: 53,
            pid: 8,
            processName: "dns.exe",
          },
        ],
      }),
    },
  });
  const proc = await kit.execute("security_process_inspect", { pid: 4242 });
  assert.equal(proc.observed.pid, 4242);
  assert.equal(proc.observed.injected, false);
  assert.equal(proc.observed.executedInProcess, false);
  assert.ok(proc.observed.modules.some((m) => m.name === "ntdll.dll"));

  const clash = await kit.execute("security_process_inspect", { name: "dup.exe" });
  assert.match(clash.error, /Select by PID/);
  assert.equal(clash.observed.candidates.length, 2);

  const net = await kit.execute("security_network_snapshot");
  assert.ok(net.observed.listeningTcp.some((c) => c.localPort === 445));
  assert.ok(net.observed.tcpConnections.some((c) => c.remoteAddress === "1.2.3.4"));
  assert.ok(net.observed.udpEndpoints.some((c) => c.localPort === 53));
  assert.ok(net.unverified.some((u) => /Malice is not inferred/.test(u)));
});

test("23-26 capture approval and role denies", async (t) => {
  assert.equal(toolCapability("security_packet_capture"), "security_capture");
  assert.equal(toolCapability("security_binary_inspect"), "security_inspect");
  assert.equal(
    authorize({ user: owner, capability: "security_capture" }).decision,
    "require_approval",
  );
  assert.equal(
    applyLegacyOwnerAutoApprove(
      authorize({ user: owner, capability: "security_capture" }),
      owner,
      true,
      "security_packet_capture",
    ).decision,
    "require_approval",
  );
  assert.equal(shouldSkipLegacyAutoApprove("security_packet_capture"), true);
  assert.equal(
    authorize({ user: trusted, capability: "security_capture" }).decision,
    "deny",
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
    authorize({ user: owner, capability: "security_inspect" }).decision,
    "allow",
  );

  const { dir } = await tempWorkspace(t);
  const tools = new Tools({
    root: dir,
    workspace: dir,
    dataDirectory: path.join(dir, ".local"),
    approve: approveFor(standard),
  });
  await assert.rejects(
    () =>
      tools.execute(
        "security_binary_inspect",
        { path: "x.exe" },
        new AbortController().signal,
      ),
    /Permission denied/,
  );
  const guestTools = new Tools({
    root: dir,
    workspace: dir,
    approve: approveFor(guest),
  });
  await assert.rejects(
    () =>
      guestTools.execute(
        "security_network_snapshot",
        {},
        new AbortController().signal,
      ),
    /Permission denied/,
  );
  const trustedCap = new Tools({
    root: dir,
    workspace: dir,
    approve: approveFor(trusted, true),
  });
  await assert.rejects(
    () =>
      trustedCap.execute(
        "security_packet_capture",
        { action: "start" },
        new AbortController().signal,
      ),
    /Permission denied|Owner-only/,
  );
  const ownerCap = new Tools({
    root: dir,
    workspace: dir,
    dataDirectory: path.join(dir, ".local"),
    approve: approveFor(owner, true),
    securityUser: owner,
    securityAdapters: {
      exists: (p) => /pktmon/i.test(String(p)),
      captureRunner: async () => ({
        packets: [
          {
            timestamp: "t",
            source: "1.1.1.1",
            destination: "2.2.2.2",
            protocol: "tcp",
            sourcePort: 1,
            destinationPort: 2,
            size: 40,
            payload: "SECRET",
          },
        ],
      }),
    },
  });
  await assert.rejects(
    () =>
      ownerCap.execute(
        "security_packet_capture",
        { action: "start" },
        new AbortController().signal,
      ),
    /APPROVAL_REQUIRED/,
  );
});

test("27 static inspection never executes the file", async (t) => {
  const { dir } = await tempWorkspace(t);
  const marker = path.join(dir, "executed.flag");
  const file = path.join(dir, "payload.exe");
  await fs.writeFile(file, minimalPe32());
  const result = inspectBinaryBuffer(await fs.readFile(file), {
    fileName: "payload.exe",
  });
  assert.equal(result.observed.executed, false);
  await assert.rejects(fs.stat(marker));
  assert.ok(result.unverified.some((u) => /was not executed/.test(u)));
});

test("28 output bounds enforced", () => {
  const extracted = extractStrings(manyStringsFixture(500));
  assert.equal(extracted.count, 400);
  assert.equal(extracted.truncated, true);
  const huge = {
    tool: "security_decompile",
    observed: { decompilation: "x".repeat(20000), bytes: Buffer.alloc(100) },
  };
  const slim = slimSecurityForRemote(huge);
  assert.equal(slim.observed.decompilation, undefined);
  assert.equal(slim.observed.bytes, undefined);
});

test("29 remote provider does not receive raw binary contents", () => {
  const payload = {
    tool: "security_binary_inspect",
    available: true,
    observed: {
      fileName: "a.exe",
      sha256: "abc",
      format: "PE32",
      bytes: "4d5a9000",
      hex: "4d5a".repeat(40),
      decompilation: "void secret(){}",
      packets: [{ payload: "PRIV" }],
      sections: [{ name: ".text", entropy: 6.1, permissions: { read: true } }],
    },
    derived: { fileEntropy: 5 },
    assessment: ["high entropy observed"],
    unverified: ["Static inspection only."],
  };
  const remote = sanitizeForRemote(JSON.stringify(payload));
  assert.ok(!remote.text.includes("void secret"));
  assert.ok(!remote.text.includes("PRIV"));
  assert.ok(!remote.text.includes("4d5a9000"));
  const stored = eventDetailForStorage(
    "security_binary_inspect",
    { path: "C:\\\\secret\\\\game.exe" },
    payload,
  );
  assert.equal(stored.args.path, "game.exe");
  assert.ok(!JSON.stringify(stored.result).includes("void secret"));
});

test("30 Hacker mode exposes reverse_security", () => {
  const hacker = capabilityPolicy({ ...DEFAULT_PREFERENCES, mode: "hacker" });
  for (const name of SECURITY_TOOLS) assert.ok(hacker.allows(name), name);
  const registry = buildCapabilityRegistry({
    preferences: { ...DEFAULT_PREFERENCES, mode: "hacker" },
    platform: "win32",
  });
  const cap = registry.find((c) => c.id === "reverse_security");
  assert.equal(cap.enabled, true);
  assert.ok(cap.supportedActions.includes("security_binary_inspect"));
  assert.ok(MODES.hacker.packs.includes("reverse_security"));
  const auto = resolveEffectiveMode({ text: "reverse engineer this binary" });
  assert.equal(auto.effectiveMode, "hacker");
});

test("31 chat request routes to dedicated security tools", () => {
  const cases = [
    ["analyze this exe", "security_binary_inspect"],
    ["reverse engineer this binary", "security_binary_inspect"],
    ["show imports", "security_binary_inspect"],
    ["find strings", "security_strings"],
    ["inspect this process", "security_process_inspect"],
    ["what DLLs is this process loading", "security_process_inspect"],
    ["scan this file with yara", "security_yara_scan"],
    ["show network connections", "security_network_snapshot"],
    ["capture traffic for this process", "security_packet_capture"],
    ["decompile this function", "security_decompile"],
    ["compare these two executables", "security_hash"],
  ];
  for (const [text, tool] of cases) {
    const intent = classifySecurityIntent(text);
    assert.equal(intent?.tool, tool, text);
    const turn = resolveTurnContext(text);
    assert.equal(turn.taskHint, tool, text);
    assert.ok(!turn.conversational, text);
    const filtered = filterToolsForTurn(
      [{ function: { name: "terminal" } }, { function: { name: tool } }],
      turn,
    );
    assert.ok(!filtered.some((d) => d.function.name === "terminal"), text);
  }
});

test("32 evidence labels stay accurate", () => {
  const result = inspectBinaryBuffer(packerNamedPe(), { fileName: "upx.exe" });
  assert.ok(result.observed);
  assert.ok(result.derived);
  assert.ok(Array.isArray(result.assessment));
  assert.ok(Array.isArray(result.unverified));
  assert.ok(detectPackerIndicators(parsePe(packerNamedPe())).includes("upx0"));
  assert.ok(result.assessment.some((a) => /packer-like section name/.test(a)));
  assert.ok(assertNoForbiddenAbsolutes(JSON.stringify(result)));
  assert.throws(() =>
    securityResult({
      tool: "security_binary_inspect",
      assessment: ["malware confirmed"],
    }),
  );
  for (const word of ["safe", "clean", "packed", "compromised"]) {
    assert.throws(() =>
      securityResult({ tool: "x", assessment: [`file is ${word}`] }),
    );
  }
});

test("hash/strings/inspect tools through toolkit + audit", async (t) => {
  const { dir, store } = await tempWorkspace(t);
  await fs.writeFile(path.join(dir, "a.exe"), peWithImports());
  await fs.writeFile(path.join(dir, "b.exe"), overlayPe());
  const kit = createSecurityToolkit({
    workspace: dir,
    dataDirectory: path.join(dir, ".local"),
    store,
    user: resolveLocalOwner(store),
  });
  const inspect = await kit.execute("security_binary_inspect", { path: "a.exe" });
  assert.equal(inspect.observed.executed, false);
  assert.ok(inspect.observed.imports.some((i) => i.dll === "KERNEL32.dll"));
  const strings = await kit.execute("security_strings", { path: "a.exe" });
  assert.equal(strings.observed.note.includes("not instructions"), true);
  const hash = await kit.execute("security_hash", {
    path: "a.exe",
    otherPath: "b.exe",
  });
  assert.equal(hash.observed.byteEqual, false);
  const rows = store.db.prepare("SELECT action, detail FROM audit_events").all();
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes("security_binary_inspected"));
  assert.ok(actions.includes("security_strings_extracted"));
  assert.ok(rows.every((r) => !/BEGIN PRIVATE|password/i.test(r.detail)));
});

test("Owner inspect executes; capture duration is clamped; metadata omits payload", async (t) => {
  const { dir } = await tempWorkspace(t);
  await fs.writeFile(path.join(dir, "a.exe"), minimalPe32Plus());
  const tools = new Tools({
    root: dir,
    workspace: dir,
    dataDirectory: path.join(dir, ".local"),
    approve: approveFor(owner, true),
    securityUser: owner,
    securityAdapters: {
      exists: (p) => /pktmon/i.test(String(p)),
      captureRunner: async ({ durationSeconds, includePayload }) => ({
        packets: [
          {
            timestamp: "t0",
            source: "10.0.0.1",
            destination: "10.0.0.2",
            protocol: "tcp",
            sourcePort: 1,
            destinationPort: 2,
            size: 64,
            payload: includePayload ? "RAW" : undefined,
          },
        ],
      }),
    },
  });
  const inspect = await tools.execute(
    "security_binary_inspect",
    { path: "a.exe" },
    new AbortController().signal,
  );
  assert.equal(inspect.observed.format, "PE32+");
  const kit = createSecurityToolkit({
    workspace: dir,
    dataDirectory: path.join(dir, ".local"),
    user: owner,
    exists: (p) => /pktmon/i.test(String(p)),
    adapters: {
      captureRunner: async ({ durationSeconds, includePayload }) => {
        assert.equal(durationSeconds, 600);
        assert.equal(includePayload, false);
        return {
          packets: [
            {
              timestamp: "t0",
              source: "a",
              destination: "b",
              protocol: "tcp",
              size: 20,
              payload: "HIDDEN",
            },
          ],
        };
      },
    },
  });
  const cap = await kit.execute("security_packet_capture", {
    action: "start",
    durationSeconds: 9999,
  });
  assert.equal(cap.observed.durationSeconds, 600);
  assert.equal(cap.observed.includePayload, false);
  const viewed = await kit.execute("security_packet_capture", {
    action: "inspect",
    captureId: cap.observed.captureId,
  });
  assert.ok(!viewed.observed.packets.some((p) => p.payload));
});
