/**
 * Self Repair + Auto defaults regressions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/index.mjs";
import {
  createUser,
  createSession,
  resolveLocalOwner,
} from "../server/users.mjs";
import { canSelfRepair, authorize } from "../server/permissions.mjs";
import { DEFAULT_PREFERENCES } from "../server/preferences.mjs";
import {
  createSelfRepairStore,
  isSelfRepairComplaint,
  canApplySelfRepair,
  canDiagnoseSelfRepair,
  isSecuritySensitivePath,
  redactSecrets,
  selfRepairCanApply,
  DEFAULT_SELF_REPAIR_SETTINGS,
} from "../server/self-repair.mjs";

const fakeOllama = {
  models: async () => [{ name: "qwen3:8b" }, { name: "qwen3:14b" }],
  inspect: async () => ({
    capabilities: ["tools"],
    model_info: { "qwen3.context_length": 32768 },
  }),
  prepare: async () => ({ alreadyLoaded: true, unloaded: [] }),
  unload: async () => [],
  chat: async ({ onToken }) => {
    onToken("I found the likely cause.");
    return { role: "assistant", content: "I found the likely cause.", tokens: 4 };
  },
};

async function runningApp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-self-repair-"));
  const app = await createApp({ dataDirectory: dir, ollama: fakeOllama });
  app.store.set("autoGaming", false);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    app,
    base: `http://127.0.0.1:${app.server.address().port}`,
    dir,
  };
}

function request(base, token, route, method = "GET", body) {
  return fetch(base + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": token,
      Connection: "close",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("Auto defaults for mode and model remain auto", () => {
  assert.equal(DEFAULT_PREFERENCES.mode, "auto");
  assert.equal(DEFAULT_PREFERENCES.model, "auto");
  assert.equal(DEFAULT_SELF_REPAIR_SETTINGS.enabled, true);
  assert.equal(DEFAULT_SELF_REPAIR_SETTINGS.autoDiagnose, true);
  assert.equal(DEFAULT_SELF_REPAIR_SETTINGS.askBeforeModify, "always");
});

test("composer markup keeps routing controls out of the chat composer", async () => {
  const html = await fs.readFile(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="chatForm" class="composer"/);
  assert.match(html, /id="attach"/);
  assert.match(html, /id="send"/);
  assert.match(html, /id="advancedRoutingSection"/);
  assert.match(html, /id="jackModeHost"/);
  assert.match(html, /id="taskModeHost"/);
  assert.match(html, /id="modelHost"/);
  // Routing controls live under Settings → Advanced, not in the composer.
  const composerBlock = html.slice(
    html.indexOf('id="chatForm"'),
    html.indexOf('id="fileInput"'),
  );
  assert.doesNotMatch(composerBlock, /jackModeHost|taskModeHost|modelHost|composerTools|modelLabel|composer-popover/);
  assert.doesNotMatch(html, /composer-toolbar/);
  assert.doesNotMatch(html, /composer-footnote/);
});

test("complaint phrases trigger self-repair detection", () => {
  for (const text of [
    "fix yourself",
    "you misunderstood me",
    "you are too slow",
    "your memory is broken",
    "that button doesn't work",
    "why did you use the wrong model?",
    "why did you search?",
    "your answer was bad",
  ])
    assert.equal(isSelfRepairComplaint(text), true, text);
  assert.equal(isSelfRepairComplaint("hello"), false);
});

test("owner-only apply; standard can diagnose but not apply", () => {
  const owner = { id: "o", role: "owner" };
  const standard = { id: "s", role: "standard" };
  const guest = { id: "g", role: "guest" };
  assert.equal(canApplySelfRepair(owner), true);
  assert.equal(canSelfRepair(owner), true);
  assert.equal(canApplySelfRepair(standard), false);
  assert.equal(canSelfRepair(standard), false);
  assert.equal(canDiagnoseSelfRepair(standard), true);
  assert.equal(canDiagnoseSelfRepair(guest), false);
  assert.equal(
    authorize({ user: standard, capability: "self_repair" }).decision,
    "deny",
  );
});

test("security-sensitive paths are flagged and secrets redacted", () => {
  assert.equal(isSecuritySensitivePath("server/permissions.mjs"), true);
  assert.equal(isSecuritySensitivePath("server/agent.mjs"), false);
  const cleaned = redactSecrets({
    token: "secret-value",
    note: "api_key=abc123xyz",
    ok: "hello",
  });
  assert.equal(cleaned.token, "[redacted]");
  assert.match(cleaned.note, /\[redacted\]/);
  assert.equal(cleaned.ok, "hello");
});

test("diagnosis does not modify files; cancel changes nothing; apply requires owner", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-sr-unit-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const owner = resolveLocalOwner(store);
  const standard = createUser(store, { displayName: "Std", role: "standard" });
  const target = path.join(dir, "sample.txt");
  await fs.writeFile(target, "alpha\n", "utf8");

  const repair = createSelfRepairStore(store, {
    repoRoot: dir,
    runTests: async () => ({ ok: true, command: "fake-test" }),
  });

  const diagnosed = await repair.diagnose({
    text: "you are too slow",
    user: owner,
    historyMessages: [],
  });
  assert.equal(diagnosed.ok, true);
  // No telemetry evidence → diagnosis only (no invented root cause / Apply).
  assert.equal(diagnosed.kind, "diagnosis");
  assert.ok(diagnosed.diagnosis);
  assert.equal(diagnosed.diagnosis.canApply, false);
  assert.equal(diagnosed.diagnosis.files.length, 0);
  assert.equal(diagnosed.diagnosis.rootCause, null);
  assert.match(diagnosed.diagnosis.summary, /No confirmed fault/i);
  assert.equal(await fs.readFile(target, "utf8"), "alpha\n");

  await repair.cancel(diagnosed.diagnosis.id, owner);
  assert.equal(await fs.readFile(target, "utf8"), "alpha\n");
  assert.match(
    JSON.stringify(repair.history()),
    /cancelled|diagnosis_clean/,
  );

  const again = await repair.diagnose({
    text: "check if there's any errors within your code",
    user: owner,
  });
  assert.equal(again.kind, "diagnosis");
  // Owner may still attach a curated patch to a diagnosis record.
  repair.attachPatches(again.diagnosis.id, owner, [
    { path: "sample.txt", oldText: "alpha\n", newText: "beta\n" },
  ]);
  const pending = repair.get(again.diagnosis.id);
  assert.equal(pending.kind, "proposal");
  assert.equal(pending.canApply, true);

  await assert.rejects(
    () => repair.apply(again.diagnosis.id, standard),
    /Only the Owner/,
  );
  assert.equal(await fs.readFile(target, "utf8"), "alpha\n");

  const applied = await repair.apply(again.diagnosis.id, owner);
  assert.equal(applied.ok, true);
  assert.equal(applied.message, "Fixed and verified.");
  assert.equal(await fs.readFile(target, "utf8"), "beta\n");
  assert.ok(repair.history().some((h) => h.result === "fixed_and_verified"));
});

test("failed repair rolls back to checkpoint", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-sr-fail-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const owner = resolveLocalOwner(store);
  const target = path.join(dir, "broken.txt");
  await fs.writeFile(target, "keep-me\n", "utf8");
  const repair = createSelfRepairStore(store, {
    repoRoot: dir,
    runTests: async () => ({ ok: false, command: "fake-fail" }),
  });
  const diagnosed = await repair.diagnose({
    text: "fix yourself",
    user: owner,
  });
  assert.equal(diagnosed.kind, "diagnosis");
  repair.attachPatches(diagnosed.diagnosis.id, owner, [
    { path: "broken.txt", oldText: "keep-me\n", newText: "changed\n" },
  ]);
  const result = await repair.apply(diagnosed.diagnosis.id, owner);
  assert.equal(result.ok, false);
  assert.equal(result.status, "reverted");
  assert.equal(await fs.readFile(target, "utf8"), "keep-me\n");
  assert.ok(repair.history().some((h) => h.result === "failed_reverted"));
});

test("security-sensitive apply requires acknowledgement", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-sr-sec-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(dir, "server"), { recursive: true });
  const owner = resolveLocalOwner(store);
  const file = path.join(dir, "server", "permissions.mjs");
  await fs.writeFile(file, "export const X = 1;\n", "utf8");
  const repair = createSelfRepairStore(store, {
    repoRoot: dir,
    runTests: async () => ({ ok: true, command: "ok" }),
  });
  const diagnosed = await repair.diagnose({
    text: "fix yourself",
    user: owner,
  });
  assert.equal(diagnosed.kind, "diagnosis");
  repair.attachPatches(diagnosed.diagnosis.id, owner, [
    {
      path: "server/permissions.mjs",
      oldText: "export const X = 1;\n",
      newText: "export const X = 2;\n",
    },
  ]);
  await assert.rejects(
    () => repair.apply(diagnosed.diagnosis.id, owner, { acknowledgeSecurity: false }),
    /Security-sensitive/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "export const X = 1;\n");
});

test("HTTP: standard cannot apply; owner can diagnose; history has no secrets", async (t) => {
  const { app, base } = await runningApp(t);
  const owner = resolveLocalOwner(app.store);
  const ownerSession = createSession(app.store, owner.id, { source: "local" });
  const standard = createUser(app.store, {
    displayName: "Standard",
    role: "standard",
  });
  const stdSession = createSession(app.store, standard.id, { source: "local" });

  const denied = await request(
    base,
    stdSession.token,
    "/api/self-repair/does-not-exist",
    "POST",
    { action: "apply" },
  );
  assert.equal(denied.status, 403);

  const settingsDenied = await request(
    base,
    stdSession.token,
    "/api/self-repair",
    "POST",
    { enabled: false },
  );
  assert.equal(settingsDenied.status, 403);

  const diag = await request(base, ownerSession.token, "/api/self-repair/x", "POST", {
    action: "diagnose",
    text: "you are too slow",
  });
  assert.equal(diag.status, 200);
  const body = await diag.json();
  assert.equal(body.ok, true);
  assert.equal(body.kind, "diagnosis");
  assert.ok(body.diagnosis?.id);

  app.selfRepair.recordLastTurn({
    total_ms: 12,
    model: "qwen3:8b",
    authorization: "Bearer SECRETTOKEN",
  });
  const hist = await (await request(base, ownerSession.token, "/api/self-repair")).json();
  assert.ok(Array.isArray(hist.history));
  assert.doesNotMatch(JSON.stringify(hist.history), /SECRETTOKEN/);
  assert.doesNotMatch(
    JSON.stringify(app.selfRepair.lastTurn()),
    /SECRETTOKEN/,
  );
});

test("status exposes selfRepair flags and preferences stay Auto", async (t) => {
  const { app, base } = await runningApp(t);
  const owner = resolveLocalOwner(app.store);
  const session = createSession(app.store, owner.id, { source: "local" });
  const status = await (
    await request(base, session.token, "/api/status")
  ).json();
  assert.equal(status.preferences.mode, "auto");
  assert.equal(status.preferences.model, "auto");
  assert.equal(status.selfRepair.settings.enabled, true);
  assert.equal(status.selfRepair.canApply, true);
});

test("self repair with no fault → diagnosis only, no Apply, no files list", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-sr-clean-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const owner = resolveLocalOwner(store);
  const repair = createSelfRepairStore(store, { repoRoot: dir });
  const result = await repair.diagnose({ text: "self repair", user: owner });
  assert.equal(result.kind, "diagnosis");
  assert.equal(result.diagnosis.canApply, false);
  assert.equal(selfRepairCanApply(result.diagnosis), false);
  assert.deepEqual(result.diagnosis.files, []);
  assert.equal(result.diagnosis.rootCause, null);
  assert.ok(result.diagnosis.checksPerformed?.length >= 2);
  await assert.rejects(
    () => repair.apply(result.diagnosis.id, owner),
    /Diagnosis-only|patch/i,
  );
});

test("check your code runs real checks and does not invent root cause", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-sr-code-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  // Healthy entrypoints → no fault.
  await fs.mkdir(path.join(dir, "server"), { recursive: true });
  await fs.mkdir(path.join(dir, "public"), { recursive: true });
  await fs.writeFile(path.join(dir, "server", "index.mjs"), "export const ok = 1;\n");
  await fs.writeFile(path.join(dir, "server", "agent.mjs"), "export const ok = 1;\n");
  await fs.writeFile(path.join(dir, "public", "app.js"), "export const ok = 1;\n");
  await fs.writeFile(path.join(dir, "public", "chat-visibility.js"), "export const ok = 1;\n");
  const owner = resolveLocalOwner(store);
  const repair = createSelfRepairStore(store, { repoRoot: dir });
  const result = await repair.diagnose({
    text: "check if there's any errors within your code",
    user: owner,
  });
  assert.equal(result.kind, "diagnosis");
  assert.equal(result.diagnosis.rootCause, null);
  assert.ok(
    result.diagnosis.checksPerformed.some((c) => c.id === "syntax" && c.status === "passed"),
  );
  assert.doesNotMatch(
    JSON.stringify(result.diagnosis),
    /User asked to check Jack's own code/,
  );
});

test("synthetic syntax failure → confirmed finding tied to that file", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-sr-syn-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(dir, "public"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "public", "app.js"),
    "const broken = {\n",
  );
  const owner = resolveLocalOwner(store);
  const repair = createSelfRepairStore(store, {
    repoRoot: dir,
    runTests: async () => ({ ok: true, command: "ok" }),
  });
  const result = await repair.diagnose({
    text: "check your code for errors",
    user: owner,
  });
  assert.equal(result.kind, "proposal");
  assert.ok(result.proposal.rootCause);
  assert.ok(result.proposal.files.includes("public/app.js"));
  assert.equal(result.proposal.canApply, false);
  assert.equal(selfRepairCanApply(result.proposal), false);
  assert.match(result.proposal.rootCause, /public\/app\.js/);
});

test("rejected proposal / diagnosis changes nothing", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-sr-rej-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const owner = resolveLocalOwner(store);
  const target = path.join(dir, "keep.txt");
  await fs.writeFile(target, "safe\n");
  const repair = createSelfRepairStore(store, {
    repoRoot: dir,
    runTests: async () => ({ ok: true, command: "ok" }),
  });
  const result = await repair.diagnose({ text: "self repair", user: owner });
  repair.attachPatches(result.diagnosis.id, owner, [
    { path: "keep.txt", oldText: "safe\n", newText: "changed\n" },
  ]);
  await repair.cancel(result.diagnosis.id, owner);
  assert.equal(await fs.readFile(target, "utf8"), "safe\n");
  assert.ok(repair.history().some((h) => h.result === "cancelled"));
});

test("formatProposalForPrompt does not instruct invented inspections", async () => {
  const { formatProposalForPrompt } = await import("../server/self-repair.mjs");
  const text = formatProposalForPrompt({
    kind: "diagnosis",
    diagnosisOnly: true,
    request: "self repair",
    summary: "No confirmed fault found yet.",
    checksPerformed: [{ id: "telemetry", status: "missing" }],
  });
  assert.match(text, /No confirmed fault/);
  assert.match(text, /Do NOT invent a root cause/);
  assert.doesNotMatch(text, /Files: server\/agent/);
});
