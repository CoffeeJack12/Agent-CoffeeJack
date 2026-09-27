/**
 * Owner-only Self Repair: diagnose → propose → approve → patch → test → rollback on failure.
 * Never silently modifies CoffeeJack source. Never stores secrets in history.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { workspacePath } from "./files.mjs";
import { patchText } from "./developer.mjs";
import { isSelfRepairCommand } from "./turn-priority.mjs";

export const DEFAULT_SELF_REPAIR_SETTINGS = {
  enabled: true,
  autoDiagnose: true,
  askBeforeModify: "always",
};

/** Paths that always count as security-sensitive. */
export const SECURITY_SENSITIVE_PATHS = [
  "server/access.mjs",
  "server/trust.mjs",
  "server/identity.mjs",
  "server/permissions.mjs",
  "server/users.mjs",
  "server/workspaces.mjs",
  "server/artifacts.mjs",
  "server/rate-limit.mjs",
  "server/privacy.mjs",
  ".env",
  ".env.example",
];

const SECRET_RE =
  /(?:api[_-]?key|secret|token|password|authorization|bearer\s+[a-z0-9._-]+|cf-access|session)/i;

export function getSelfRepairSettings(store) {
  const saved = store.get("selfRepair", null);
  return { ...DEFAULT_SELF_REPAIR_SETTINGS, ...(saved && typeof saved === "object" ? saved : {}) };
}

export function saveSelfRepairSettings(store, input = {}) {
  const next = {
    enabled: input.enabled !== false,
    autoDiagnose: input.autoDiagnose !== false,
    askBeforeModify:
      input.askBeforeModify === "never" ? "always" : "always", // always require approval
  };
  store.set("selfRepair", next);
  return next;
}

/** @deprecated prefer isSelfRepairCommand — kept for call-site compatibility */
export function isSelfRepairComplaint(text = "") {
  return isSelfRepairCommand(text);
}

export function canApplySelfRepair(user) {
  return String(user?.role || "").toLowerCase() === "owner";
}

export function canDiagnoseSelfRepair(user) {
  const role = String(user?.role || "").toLowerCase();
  return role === "owner" || role === "trusted" || role === "standard";
}

export function isSecuritySensitivePath(relPath = "") {
  const normalized = String(relPath).replace(/\\/g, "/").replace(/^\.\//, "");
  return SECURITY_SENSITIVE_PATHS.some(
    (p) => normalized === p || normalized.startsWith(p + "/"),
  );
}

export function redactSecrets(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (SECRET_RE.test(value) && value.length > 12)
      return "[redacted]";
    return value.replace(
      /(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    );
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_RE.test(k)) out[k] = "[redacted]";
      else out[k] = redactSecrets(v);
    }
    return out;
  }
  return value;
}

export function createSelfRepairStore(store, { repoRoot, runTests } = {}) {
  const pending = new Map();

  function history() {
    const list = store.get("selfRepairHistory", []);
    return Array.isArray(list) ? list : [];
  }

  function pushHistory(entry) {
    const next = [redactSecrets(entry), ...history()].slice(0, 50);
    store.set("selfRepairHistory", next);
    return next[0];
  }

  function recordLastTurn(telemetry) {
    store.set("lastTurnTelemetry", redactSecrets(telemetry));
  }

  function lastTurn() {
    return store.get("lastTurnTelemetry", null);
  }

  async function diagnose({
    text,
    chatId,
    user,
    historyMessages = [],
    settings,
  }) {
    if (!getSelfRepairSettings(store).enabled && !settings?.enabled)
      return {
        ok: false,
        reason: "self_repair_disabled",
        diagnosis: "Self Repair is disabled in Settings.",
      };
    if (!canDiagnoseSelfRepair(user))
      return {
        ok: false,
        reason: "denied",
        diagnosis: "Your role cannot request Self Repair diagnosis.",
      };

    const request = String(text || "").trim().slice(0, 240);
    const checks = [];
    const evidence = [];
    const findings = [];

    // --- READ-ONLY EVIDENCE COLLECTION (never invent a root cause) ---
    const telemetry = lastTurn();
    checks.push({
      id: "telemetry",
      label: "Last-turn latency/routing telemetry",
      status: telemetry ? "checked" : "missing",
    });
    if (telemetry) {
      evidence.push({ type: "telemetry", summary: summarizeTelemetry(telemetry), data: telemetry });
    }

    const recentEvents = safeEvents(store, user?.id).slice(0, 40);
    const failedEvents = recentEvents.filter(
      (e) => String(e.status || "").toLowerCase() === "error",
    );
    checks.push({
      id: "events",
      label: "Recent agent/tool events",
      status: "checked",
      detail: `${recentEvents.length} recent, ${failedEvents.length} errors`,
    });
    if (failedEvents.length) {
      evidence.push({
        type: "failed_events",
        count: failedEvents.length,
        samples: failedEvents.slice(0, 5).map((e) => ({
          tool: e.tool,
          status: e.status,
          created: e.created,
          detail: safeJsonSlice(e.detail, 240),
        })),
      });
    }

    let gitMeta = { isGit: false, commit: null, status: null };
    if (repoRoot) {
      gitMeta = await captureGitMeta(repoRoot);
      checks.push({
        id: "git",
        label: "Repository git status",
        status: gitMeta.isGit ? "checked" : "unavailable",
        detail: gitMeta.isGit
          ? `HEAD ${String(gitMeta.commit || "").slice(0, 12)}; porcelain ${gitMeta.status ? "dirty/clean known" : "empty"}`
          : "Not a git workspace",
      });
      evidence.push({
        type: "git",
        commit: gitMeta.commit,
        dirty: Boolean(gitMeta.status && gitMeta.status.trim()),
        statusPreview: String(gitMeta.status || "").slice(0, 500),
      });
    } else {
      checks.push({
        id: "git",
        label: "Repository git status",
        status: "unavailable",
      });
    }

    const wantsCodeHealth =
      /\b(?:your(?: own)? code|coffeejack|repository|repo|source|errors? within|check your)\b|كودك|الكود/i.test(
        request,
      ) || /^(?:self[-\s]?repair|diagnose yourself|inspect yourself)\b/i.test(request);

    let syntaxCheck = null;
    if (wantsCodeHealth && repoRoot) {
      syntaxCheck = await runSyntaxChecks(repoRoot);
      checks.push({
        id: "syntax",
        label: "Static syntax check (node --check on entrypoints)",
        status: syntaxCheck.ok ? "passed" : "failed",
        detail: syntaxCheck.summary,
      });
      evidence.push({ type: "syntax", ...syntaxCheck });
      if (!syntaxCheck.ok) {
        findings.push({
          id: "syntax_error",
          confidence: "high",
          problem: "Syntax/load error in CoffeeJack source entrypoints.",
          rootCause: syntaxCheck.failures
            .map((f) => `${f.file}: ${f.error}`)
            .join("; ")
            .slice(0, 500),
          files: syntaxCheck.failures.map((f) => f.file),
          evidenceIds: ["syntax"],
        });
      }
    }

    // Latency anomaly only when telemetry exists AND is extreme.
    if (telemetry && typeof telemetry.first_ui_token_ms === "number") {
      const slow =
        telemetry.first_ui_token_ms >= 5000 ||
        (typeof telemetry.total_ms === "number" && telemetry.total_ms >= 8000);
      if (slow && /\bslow|latency|too slow|بطيء|delay\b/i.test(request)) {
        const bottleneck = rankBottleneck(telemetry);
        findings.push({
          id: "latency_anomaly",
          confidence: "medium",
          problem: "Responses feel slow on a measured turn.",
          rootCause: `Measured first_ui_token_ms=${telemetry.first_ui_token_ms}; bottleneck=${bottleneck.name} (~${bottleneck.ms}ms); model=${telemetry.model || "?"}; kind=${telemetry.kind || "?"}; fastPath=${telemetry.fastPath}.`,
          files: filesForBottleneck(bottleneck.name),
          evidenceIds: ["telemetry"],
        });
      }
    }

    // Recent tool failures become findings only when they look like CoffeeJack
    // infrastructure bugs — not ordinary user-task misses (ENOENT for a missing
    // workspace file the user asked to read, approval declines, etc.).
    if (failedEvents.length && /\b(?:error|broken|bug|fail|crash|exception)\b/i.test(request)) {
      const infra = failedEvents.filter((e) => looksLikeInfraFailure(e));
      if (infra.length) {
        const sample = infra[0];
        findings.push({
          id: "recent_tool_error",
          confidence: "medium",
          problem: `Infrastructure tool failure: ${sample.tool || "unknown"}.`,
          rootCause: `Event status=error for tool=${sample.tool}. Detail: ${safeJsonSlice(sample.detail, 200)}`,
          files: guessFilesForTool(sample.tool),
          evidenceIds: ["failed_events"],
        });
      }
    }

    // Bare "self repair" / "diagnose yourself" without a specific symptom must
    // not invent findings from unrelated prior chat tool misses.
    const bareDiagnose =
      /^(?:self[-\s]?repair|diagnose yourself|inspect yourself|fix yourself|debug yourself|أصلح\s*نفسك|افحص\s*نفسك)[.!؟?\s]*$/iu.test(
        request,
      );
    if (bareDiagnose) {
      // Keep only high-confidence structural findings (e.g. syntax). Drop speculative ones.
      for (let i = findings.length - 1; i >= 0; i--) {
        if (findings[i].id === "recent_tool_error") findings.splice(i, 1);
      }
    }

    const confirmed = findings.filter((f) => f.confidence !== "low");
    const primary = confirmed[0] || null;

    // Generic "self repair" / "check your code" with no concrete fault → diagnosis only.
    if (!primary) {
      const diagnosis = {
        id: randomUUID(),
        kind: "diagnosis",
        status: "complete",
        createdAt: new Date().toISOString(),
        chatId: chatId || null,
        userId: user?.id || null,
        request,
        checksPerformed: checks,
        evidence: redactSecrets(evidence),
        findings: [],
        confidence: "none",
        summary: "No confirmed fault found yet.",
        message:
          "No confirmed fault found yet. Checked telemetry, recent tool events, repository state" +
          (syntaxCheck ? ", and entrypoint syntax" : "") +
          ".",
        // Explicitly absent repair fields:
        rootCause: null,
        files: [],
        plan: [],
        risk: null,
        patches: [],
        canApply: false,
        diagnosisOnly: true,
        modified: false,
      };
      pending.set(diagnosis.id, diagnosis);
      pushHistory({
        id: diagnosis.id,
        timestamp: diagnosis.createdAt,
        issue: request,
        diagnosis: diagnosis.summary,
        proposal: null,
        ownerDecision: null,
        filesChanged: [],
        testsRun: [],
        result: "diagnosis_clean",
        checkpoint: null,
      });
      return { ok: true, kind: "diagnosis", diagnosis, proposal: null };
    }

    // Confirmed finding — proposal only if we also have a concrete patch later.
    // Without patches: still emit diagnosis-with-finding (no Apply).
    const proposal = {
      id: randomUUID(),
      kind: "proposal",
      status: "proposed",
      createdAt: new Date().toISOString(),
      chatId: chatId || null,
      userId: user?.id || null,
      request,
      problem: primary.problem,
      rootCause: primary.rootCause,
      files: [...new Set(primary.files || [])],
      plan: [
        "Confirm the finding against the collected evidence",
        "Prepare the smallest source patch tied to those files",
        "Owner approves Apply fix",
        "Run focused tests; rollback on failure",
      ],
      risk: (primary.files || []).some(isSecuritySensitivePath) ? "high" : "medium",
      securitySensitive: (primary.files || []).some(isSecuritySensitivePath),
      patches: [],
      evidence: redactSecrets(evidence),
      checksPerformed: checks,
      findings: confirmed,
      confidence: primary.confidence,
      canApply: false,
      diagnosisOnly: false,
      modified: false,
      message: "Confirmed issue found. Attach a concrete patch before Apply fix.",
    };
    pending.set(proposal.id, proposal);
    pushHistory({
      id: proposal.id,
      timestamp: proposal.createdAt,
      issue: proposal.problem,
      diagnosis: proposal.rootCause,
      proposal: {
        files: proposal.files,
        plan: proposal.plan,
        risk: proposal.risk,
        securitySensitive: proposal.securitySensitive,
        canApply: false,
      },
      ownerDecision: null,
      filesChanged: [],
      testsRun: [],
      result: "finding_awaiting_patch",
      checkpoint: null,
    });
    // Without machine patches, UI must treat this as non-applyable proposal.
    return { ok: true, kind: "proposal", proposal, diagnosis: null };
  }

  async function cancel(id, user) {
    const item = pending.get(id);
    if (!item) throw new Error("Self-repair proposal not found");
    item.status = "cancelled";
    pending.delete(id);
    pushHistory({
      id,
      timestamp: new Date().toISOString(),
      issue: item.problem || item.request || item.summary,
      diagnosis: item.rootCause || item.summary || item.message,
      proposal:
        item.kind === "proposal"
          ? { files: item.files, plan: item.plan }
          : null,
      ownerDecision: "rejected",
      filesChanged: [],
      testsRun: [],
      result: "cancelled",
      checkpoint: null,
      actorUserId: user?.id,
    });
    return { ok: true, status: "cancelled" };
  }

  async function apply(id, user, { acknowledgeSecurity = false } = {}) {
    if (!canApplySelfRepair(user)) {
      const err = new Error("Only the Owner can apply Self Repair");
      err.status = 403;
      throw err;
    }
    const proposal = pending.get(id);
    if (!proposal) throw new Error("Self-repair proposal not found");
    if (proposal.kind === "diagnosis" || proposal.diagnosisOnly) {
      const err = new Error(
        "Diagnosis-only results cannot be applied. A confirmed finding with an attached patch is required.",
      );
      err.status = 400;
      err.code = "diagnosis_only";
      throw err;
    }
    if (proposal.status !== "proposed")
      throw new Error("Proposal is no longer pending");
    if (!repoRoot) throw new Error("CoffeeJack repository path is unavailable");
    if (proposal.securitySensitive && !acknowledgeSecurity) {
      const err = new Error(
        "Security-sensitive change requires explicit owner acknowledgement",
      );
      err.status = 400;
      err.code = "security_ack_required";
      throw err;
    }
    if (!proposal.patches?.length) {
      const err = new Error(
        "This proposal has no machine-applicable patch yet. Attach a concrete patch before Apply fix.",
      );
      err.status = 400;
      err.code = "no_patches";
      throw err;
    }

    const gitMeta = await captureGitMeta(repoRoot);
    const checkpointId = randomUUID();
    const checkpointDir = path.join(
      repoRoot,
      ".local",
      "self-repair",
      "checkpoints",
      checkpointId,
    );
    await fs.mkdir(checkpointDir, { recursive: true });
    const changed = [];

    try {
      for (const patch of proposal.patches) {
        const rel = normalizeRepoPath(patch.path);
        if (!rel || rel.includes(".."))
          throw new Error("Invalid patch path: " + patch.path);
        if (isSecuritySensitivePath(rel) && !acknowledgeSecurity)
          throw new Error("Security-sensitive path blocked: " + rel);
        const full = await workspacePath(repoRoot, rel);
        const original = await fs.readFile(full, "utf8");
        const backup = path.join(checkpointDir, rel);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.writeFile(backup, original, "utf8");
        const next = patchText(original, patch.oldText, patch.newText);
        await fs.writeFile(full, next, "utf8");
        changed.push(rel);
      }

      const focused = uniqueTestFiles(proposal.files);
      const testResults = [];
      for (const file of focused) {
        const result = await (runTests
          ? runTests({ files: [file], cwd: repoRoot })
          : runNodeTest(file, repoRoot));
        testResults.push(result);
        if (!result.ok) throw Object.assign(new Error("Focused tests failed"), { testResults });
      }
      if (proposal.securitySensitive) {
        const securitySuite = await (runTests
          ? runTests({
              files: [
                "tests/remote-trust.test.mjs",
                "tests/access.test.mjs",
                "tests/artifacts-isolation.test.mjs",
              ],
              cwd: repoRoot,
            })
          : runNodeTest(
              "tests/remote-trust.test.mjs tests/access.test.mjs tests/artifacts-isolation.test.mjs",
              repoRoot,
            ));
        testResults.push(securitySuite);
        if (!securitySuite.ok)
          throw Object.assign(new Error("Security tests failed"), { testResults });
      }

      proposal.status = "applied";
      proposal.modified = true;
      pending.delete(id);
      const record = pushHistory({
        id,
        timestamp: new Date().toISOString(),
        issue: proposal.problem,
        diagnosis: proposal.rootCause,
        proposal: {
          files: proposal.files,
          plan: proposal.plan,
          risk: proposal.risk,
          securitySensitive: proposal.securitySensitive,
        },
        ownerDecision: "approved",
        filesChanged: changed,
        testsRun: testResults.map((t) => ({
          command: t.command,
          ok: t.ok,
        })),
        result: "fixed_and_verified",
        checkpoint: {
          id: checkpointId,
          commit: gitMeta.commit,
          status: gitMeta.status,
        },
        actorUserId: user.id,
      });
      return {
        ok: true,
        status: "applied",
        filesChanged: changed,
        tests: testResults,
        checkpoint: record.checkpoint,
        message: "Fixed and verified.",
      };
    } catch (error) {
      await restoreCheckpoint(repoRoot, checkpointDir, changed);
      pending.delete(id);
      pushHistory({
        id,
        timestamp: new Date().toISOString(),
        issue: proposal.problem,
        diagnosis: proposal.rootCause,
        proposal: { files: proposal.files, plan: proposal.plan },
        ownerDecision: "approved",
        filesChanged: [],
        testsRun: (error.testResults || []).map((t) => ({
          command: t.command,
          ok: t.ok,
        })),
        result: "failed_reverted",
        checkpoint: {
          id: checkpointId,
          commit: gitMeta.commit,
          status: gitMeta.status,
        },
        error: String(error.message || error).slice(0, 500),
        actorUserId: user.id,
      });
      return {
        ok: false,
        status: "reverted",
        message: "The fix failed validation and was reverted.",
        error: String(error.message || error),
      };
    }
  }

  /**
   * Owner may attach exact patches. Upgrades a diagnosis/finding into an applyable proposal.
   */
  function attachPatches(id, user, patches) {
    if (!canApplySelfRepair(user)) {
      const err = new Error("Only the Owner can attach Self Repair patches");
      err.status = 403;
      throw err;
    }
    const item = pending.get(id);
    if (!item) throw new Error("Self-repair proposal not found");
    if (!Array.isArray(patches) || !patches.length)
      throw new Error("Patches required");
    for (const p of patches) {
      if (!p?.path || typeof p.oldText !== "string" || typeof p.newText !== "string")
        throw new Error("Each patch needs path, oldText, newText");
      if (isSecuritySensitivePath(p.path)) item.securitySensitive = true;
    }
    item.patches = patches.map((p) => ({
      path: normalizeRepoPath(p.path),
      oldText: p.oldText,
      newText: p.newText,
    }));
    // Upgrade diagnosis → proposal once a concrete patch exists.
    item.kind = "proposal";
    item.status = "proposed";
    item.diagnosisOnly = false;
    item.canApply = true;
    item.problem =
      item.problem ||
      item.summary ||
      item.request ||
      "Owner-attached Self Repair patch";
    item.rootCause =
      item.rootCause ||
      "Concrete patch attached by Owner after diagnosis; apply only after approval.";
    item.files = [
      ...new Set([
        ...(item.files || []),
        ...item.patches.map((p) => p.path),
      ]),
    ];
    item.plan = item.plan?.length
      ? item.plan
      : [
          "Apply the attached patch",
          "Run focused verification tests",
          "Keep or rollback",
        ];
    item.risk = item.securitySensitive ? "high" : item.risk || "medium";
    item.message = "Concrete patch ready for Owner approval.";
    return item;
  }

  return {
    diagnose,
    cancel,
    apply,
    attachPatches,
    get: (id) => pending.get(id) || null,
    listPending: () => [...pending.values()],
    history,
    recordLastTurn,
    lastTurn,
    settings: () => getSelfRepairSettings(store),
    saveSettings: (input) => saveSelfRepairSettings(store, input),
  };
}

function rankBottleneck(telemetry = {}) {
  const pairs = [
    ["routing_ms", telemetry.routing_ms],
    ["context_build_ms", telemetry.context_build_ms],
    ["model_load_ms", telemetry.model_load_ms],
    ["model_prepare_ms", telemetry.model_prepare_ms],
    ["first_token_ms", telemetry.first_token_ms],
    ["first_ui_token_ms", telemetry.first_ui_token_ms],
    ["generation_ms", telemetry.generation_ms],
    ["tool_ms", telemetry.tool_ms],
  ].filter(([, ms]) => typeof ms === "number");
  pairs.sort((a, b) => b[1] - a[1]);
  const top = pairs[0] || ["total_ms", telemetry.total_ms || 0];
  return { name: top[0], ms: top[1] };
}

function looksLikeInfraFailure(event) {
  const detail = safeJsonSlice(event?.detail, 500);
  const tool = String(event?.tool || "");
  if (/ENOENT|no such file|not found|approval|denied|budget|cancelled/i.test(detail))
    return false;
  if (/TypeError|ReferenceError|SyntaxError|AssertionError|EACCES|EPERM|Cannot find module/i.test(detail))
    return true;
  if (/self.?repair|index\.mjs|agent\.mjs/i.test(detail)) return true;
  // Unknown tool crash with stack-ish content.
  if (/at\s+\S+\s+\(.*\.mjs:\d+/i.test(detail)) return true;
  if (/inspect_pc|desktop/i.test(tool) && /EACCES|blocked/i.test(detail)) return true;
  return false;
}

function summarizeTelemetry(telemetry = {}) {
  return {
    model: telemetry.model,
    kind: telemetry.kind,
    fastPath: telemetry.fastPath,
    first_ui_token_ms: telemetry.first_ui_token_ms,
    total_ms: telemetry.total_ms,
    model_already_loaded: telemetry.model_already_loaded,
  };
}

function filesForBottleneck(name) {
  if (/routing|model_load|model_prepare|first_token|first_ui/i.test(name))
    return ["server/router.mjs", "server/latency.mjs", "server/agent.mjs"];
  if (/tool/i.test(name)) return ["server/agent.mjs", "server/tools.mjs"];
  return ["server/latency.mjs", "server/agent.mjs"];
}

function guessFilesForTool(tool) {
  const name = String(tool || "");
  if (/research|web_search/i.test(name)) return ["server/research.mjs", "server/agent.mjs"];
  if (/inspect_pc|desktop/i.test(name)) return ["server/tools.mjs"];
  if (/remember|memory|recall/i.test(name)) return ["server/auto-memory.mjs", "server/store.mjs"];
  return ["server/agent.mjs"];
}

function safeEvents(store, userId) {
  try {
    return store.events(userId) || [];
  } catch {
    return [];
  }
}

function safeJsonSlice(value, max = 240) {
  try {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return String(raw || "").slice(0, max);
  } catch {
    return "";
  }
}

async function runSyntaxChecks(repoRoot) {
  const targets = [
    "server/index.mjs",
    "server/agent.mjs",
    "public/app.js",
    "public/chat-visibility.js",
  ];
  const failures = [];
  const checked = [];
  for (const rel of targets) {
    const full = path.join(repoRoot, rel);
    try {
      await fs.access(full);
    } catch {
      continue;
    }
    checked.push(rel);
    const result = await runCommand(process.execPath, ["--check", full], repoRoot, 20000);
    if (!result.ok) {
      failures.push({
        file: rel,
        error: String(result.stderr || result.stdout || "syntax check failed")
          .trim()
          .slice(0, 300),
      });
    }
  }
  return {
    ok: failures.length === 0,
    checked,
    failures,
    summary:
      failures.length === 0
        ? `Passed node --check on ${checked.length} entrypoints`
        : `Failed ${failures.length}/${checked.length}: ${failures.map((f) => f.file).join(", ")}`,
  };
}

function normalizeRepoPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function uniqueTestFiles(files = []) {
  const out = new Set();
  for (const f of files) {
    if (f.startsWith("tests/") && f.endsWith(".test.mjs")) out.add(f);
    else if (f.includes("conversation-intent"))
      out.add("tests/turn-context.test.mjs");
    else if (f.includes("local-models") || f.includes("router"))
      out.add("tests/local-auto-router.test.mjs");
    else if (f.includes("latency")) out.add("tests/latency-stream.test.mjs");
  }
  if (!out.size) out.add("tests/local-auto-router.test.mjs");
  return [...out];
}

async function captureGitMeta(repoRoot) {
  const commit = await gitCapture(repoRoot, ["rev-parse", "HEAD"]);
  const status = await gitCapture(repoRoot, ["status", "--porcelain"]);
  return {
    commit: commit.ok ? commit.stdout.trim() : null,
    status: status.ok ? status.stdout.slice(0, 4000) : null,
    isGit: commit.ok,
  };
}

function gitCapture(cwd, args) {
  return runCommand("git", args, cwd, 15000);
}

async function restoreCheckpoint(repoRoot, checkpointDir, changed) {
  for (const rel of changed) {
    try {
      const backup = path.join(checkpointDir, rel);
      const full = await workspacePath(repoRoot, rel);
      const original = await fs.readFile(backup, "utf8");
      await fs.writeFile(full, original, "utf8");
    } catch {
      // best-effort restore
    }
  }
}

function runNodeTest(spec, cwd) {
  const args = ["--test", ...String(spec).split(/\s+/).filter(Boolean)];
  const nodeBin = process.execPath;
  return runCommand(nodeBin, args, cwd, 120000).then((r) => ({
    ...r,
    command: `node ${args.join(" ")}`,
  }));
}

function runCommand(command, args, cwd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        ok: false,
        code: -1,
        stdout: stdout.slice(0, 8000),
        stderr: (stderr + "\n[timeout]").slice(0, 8000),
        command: `${command} ${args.join(" ")}`,
      });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout: stdout.slice(0, 8000),
        stderr: stderr.slice(0, 8000),
        command: `${command} ${args.join(" ")}`,
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: -1,
        stdout: "",
        stderr: String(error.message || error),
        command: `${command} ${args.join(" ")}`,
      });
    });
  });
}

export function formatProposalForPrompt(item) {
  if (!item) return "";
  if (item.kind === "diagnosis" || item.diagnosisOnly) {
    return [
      "SELF REPAIR DIAGNOSIS (read-only — no patch applied).",
      `Request: ${item.request || item.problem || ""}`,
      `Result: ${item.summary || item.message || "No confirmed fault found yet."}`,
      `Checks: ${(item.checksPerformed || []).map((c) => `${c.id}:${c.status}`).join(", ") || "n/a"}`,
      "Do NOT claim you ran tests or inspections that are not listed in Checks.",
      "Do NOT invent a root cause. Do NOT list files to change. Do NOT claim Fixed.",
    ].join("\n");
  }
  return [
    "SELF REPAIR FINDING (read-only until Owner Apply fix).",
    `Problem: ${item.problem}`,
    `Confirmed root cause: ${item.rootCause}`,
    `Files tied to evidence: ${(item.files || []).join(", ") || "n/a"}`,
    `Plan:\n${(item.plan || []).map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    `Risk: ${item.risk}${item.securitySensitive ? " (Security-sensitive change)" : ""}`,
    `canApply=${Boolean(item.canApply && item.patches?.length)}`,
    "Speak truthfully: say you found a likely cause. Never say Fixed and verified until Apply succeeds. Never claim tests ran unless listed in evidence.",
  ].join("\n");
}

/** True when the UI may show Apply fix. */
export function selfRepairCanApply(item) {
  return Boolean(
    item &&
      item.kind === "proposal" &&
      !item.diagnosisOnly &&
      Array.isArray(item.patches) &&
      item.patches.length > 0,
  );
}
