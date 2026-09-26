import { getPreferences, savePreferences, LANGUAGES, ASSISTANT_LANGUAGES, APP_LANGUAGES, MODES, PACKS, PREFERENCE_OPTIONS, MEMORY_BEHAVIORS } from "./preferences.mjs";
import { resolveEffectiveMode } from "./auto-mode.mjs";
import { memoryCategory, createMemoryProposalStore } from "./auto-memory.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  accessFromEnvironment,
  isNativeRemoteAccess,
} from "./access.mjs";
import { classifyRequest, expectedOrigin } from "./trust.mjs";
import { createRateLimiter, AUTH_RATE, REMOTE_RATE } from "./rate-limit.mjs";
import { Store } from "./store.mjs";
import { Ollama } from "./ollama.mjs";
import { Tools, runProcess } from "./tools.mjs";
import { routeModel } from "./router.mjs";
import { runAgent } from "./agent.mjs";
import { isPureGreeting, emitInstantGreeting } from "./greeting.mjs";
import { createDefaultRegistry } from "./providers/index.mjs";
import {
  buildCouncilPlan,
  runCouncil,
  runCouncilEvidenceRound,
  councilUiSummary,
  buildEvidencePack,
  formatEvidencePack,
  shouldRunEvidenceRound,
  synthesizeFromEvidence,
  evidenceTypesFromPack,
} from "./council.mjs";
import {
  lessonFromCodingSuccess,
  persistVerifiedLesson,
} from "./lessons.mjs";
import { workspacePath } from "./files.mjs";
import { createLabToolkit } from "./security/adaptive/index.mjs";
import { getPersona, validatePersona, selfModel } from "./personality.mjs";
import {
  applyLegacyOwnerAutoApprove,
  approvalConsequence,
  authorize,
  canManageUsers,
  canSelfRepair,
  canToggleGaming,
  permissionSummary,
  publicAccountNeedsVerification,
  toolCapability,
} from "./permissions.mjs";
import {
  ROLES,
  audit,
  createSession,
  createUser,
  disableUser,
  getSession,
  getUser,
  listUsers,
  resolveLocalOwner,
  revokeSession,
  touchSession,
  updateUser,
} from "./users.mjs";
import {
  ensureIdentitySchema,
  findIdentitiesForUser,
  linkExternalIdentity,
  resolveExternalIdentity,
  IDENTITY_PROVIDER,
} from "./identity.mjs";
import {
  ensureWorkspaceSchema,
  ensureOwnerWorkspace,
  ensureUserWorkspace,
  listWorkspacesForUser,
  resolveActiveWorkspace,
  setChatWorkspace,
  userCanAccessWorkspace,
  getWorkspace,
  getChatWorkspaceId,
  updateWorkspaceRoot,
} from "./workspaces.mjs";
import {
  ensureArtifactSchema,
  authorizeArtifactRead,
  cleanupArtifacts,
  migrateLegacyArtifacts,
} from "./artifacts.mjs";
import {
  shouldAttachVerification,
  resolveTurnContext,
  eventsForCurrentTurn,
  latestEventId,
  filterToolsForTurn,
} from "./conversation-intent.mjs";
import {
  attachOwnerCredentials,
  authenticateAccount,
  backupSqliteOnce,
  ensureAuthSchema,
  publicUser,
  registerAccount,
  requestPasswordReset,
  resetPassword,
  resendVerification,
  verifyEmail,
} from "./accounts.mjs";
import { mailStatus } from "./email.mjs";
import { loadLocalEnv } from "./env.mjs";
import { resolveLocalModelPlan } from "./local-models.mjs";
import { createTurnTiming, devTimingEnabled } from "./latency.mjs";
import {
  createSelfRepairStore,
  isSelfRepairComplaint,
  formatProposalForPrompt,
  canDiagnoseSelfRepair,
} from "./self-repair.mjs";

export async function createApp({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  dataDirectory,
  ollama: providedOllama,
  remoteAccess,
  mailSender,
  mailEnv,
} = {}) {
  const access =
    remoteAccess === undefined ? accessFromEnvironment() : remoteAccess;
  const mail = { send: mailSender, env: mailEnv ?? process.env };
  const data = dataDirectory ?? path.join(root, ".local");
  const artifacts = path.join(data, "artifacts");
  await fs.mkdir(artifacts, { recursive: true });
  const store = new Store(data);
  ensureAuthSchema(store);
  await backupSqliteOnce(data);
  ensureIdentitySchema(store);
  ensureWorkspaceSchema(store);
  ensureArtifactSchema(store);
  const owner = resolveLocalOwner(store);
  await ensureOwnerWorkspace(store, { root, dataDirectory: data });
  await migrateLegacyArtifacts(store, artifacts, { root });
  // In-process/test handle only. Anonymous browser requests never receive this
  // token as a cookie or inferred Owner session — localhost still requires login.
  const boot = createSession(store, owner.id, { source: "local" });
  let token = boot.token;
  const ollama = providedOllama ?? new Ollama(process.env.OLLAMA_URL);
  const registry = createDefaultRegistry(ollama);
  const approvals = new Map();
  const memoryProposals = createMemoryProposalStore(store);
  const selfRepair = createSelfRepairStore(store, { repoRoot: root });
  let active = null,
    gaming = false,
    autoGaming = false,
    gameScanBusy = false;
  // Legacy global workspace setting remains owner's CoffeeJack workspace path.
  let workspace = store.get("workspace", path.join(data, "projects"));
  await fs.mkdir(workspace, { recursive: true });
  const ownerWs = listWorkspacesForUser(store, owner.id)[0];
  if (ownerWs?.root_path) workspace = ownerWs.root_path;
  const settings = () => ({
    model: store.get("model", process.env.COFFEEJACK_MODEL ?? "qwen3:8b"),
    codingModel: store.get("codingModel", ""),
    visionModel: store.get("visionModel", ""),
    instructions: store.get("instructions", ""),
    workspace,
    autoApprove: store.get("autoApprove", false),
    gameProcesses: store.get("gameProcesses", [
      "cs2.exe",
      "cod.exe",
      "FortniteClient-Win64-Shipping.exe",
      "Cyberpunk2077.exe",
      "eldenring.exe",
      "GTA5.exe",
    ]),
    autoGaming: store.get("autoGaming", true),
  });
  const tools = new Tools({
    root,
    workspace,
    store,
    artifactDirectory: artifacts,
    artifactBase: artifacts,
    dataDirectory: data,
    approve: async (name, args, signal) => {
      const user = active?.userId
        ? getUser(store, active.userId)
        : resolveLocalOwner(store);
      const capability = toolCapability(name, args);
      const workspaceMeta = active?.workspaceId
        ? getWorkspace(store, active.workspaceId)
        : null;
      let decision = authorize({
        user,
        capability,
        action: name,
        resource: workspaceMeta || args?.path || args?.command,
        context: {
          memoryPack: true,
          workspaceId: active?.workspaceId || null,
          labAction: name === "security_lab" ? args?.action : undefined,
        },
      });
      decision = applyLegacyOwnerAutoApprove(
        decision,
        user,
        store.get("autoApprove", false),
        name,
        args,
      );
      if (decision.decision === "allow") return;
      if (decision.decision === "deny")
        throw new Error(`Permission denied: ${decision.reason}`);
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const finish = (allowed) => {
          clearTimeout(timer);
          approvals.delete(id);
          signal.removeEventListener("abort", cancel);
          allowed
            ? resolve()
            : reject(new Error("Operation declined or expired"));
        };
        const cancel = () => finish(false);
        const timer = setTimeout(cancel, 300000);
        const consequence = approvalConsequence(name, args);
        approvals.set(id, {
          id,
          name,
          args,
          finish,
          userId: user.id,
          consequence,
        });
        signal.addEventListener("abort", cancel, { once: true });
        active?.emit({ type: "approval", id, name, args, consequence });
      });
    },
  });
  const setGaming = async (enabled) => {
    gaming = enabled;
    if (enabled) {
      const previous = active;
      previous?.controller.abort();
      if (previous) await previous.finished;
      await tools.close();
      return await ollama.unload();
    }
    return [];
  };
  const scanGames = async () => {
    if (
      gameScanBusy ||
      process.platform !== "win32" ||
      !store.get("autoGaming", true)
    )
      return;
    gameScanBusy = true;
    try {
      const result = await runProcess("tasklist.exe", ["/FO", "CSV", "/NH"], {
        timeout: 5000,
      });
      const names = result.output
        .split("\n")
        .map((l) => l.match(/^"([^"]+)"/)?.[1]?.toLowerCase())
        .filter(Boolean);
      const found = settings().gameProcesses.some((p) =>
        names.includes(p.toLowerCase()),
      );
      if (found && !gaming) {
        autoGaming = true;
        await setGaming(true);
      } else if (!found && autoGaming) {
        autoGaming = false;
        await setGaming(false);
      }
    } catch {
      /* Manual gaming mode remains available if process detection fails. */
    } finally {
      gameScanBusy = false;
    }
  };
  const timer = setInterval(scanGames, 15000);
  timer.unref();
  const json = (res, code, value) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  const body = async (req) => {
    let bytes = 0,
      chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 30000000) throw new Error("Request too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  };
  const sessionIdentity = (req) => {
    const headerToken = req.headers["x-coffeejack-token"];
    const cookieMatch = /(?:^|;\s*)coffeejack_session=([^;]+)/.exec(
      req.headers.cookie || "",
    );
    const requestToken =
      typeof headerToken === "string" && headerToken
        ? headerToken
        : cookieMatch
          ? decodeURIComponent(cookieMatch[1])
          : undefined;
    const session = getSession(store, requestToken);
    if (!session) return undefined;
    touchSession(store, requestToken);
    const user = getUser(store, session.user_id);
    if (!user) return undefined;
    return { token: requestToken, user, session };
  };
  const remoteLimiter = createRateLimiter({ windowMs: 60_000, max: 40 });
  const authLimiter = createRateLimiter({ windowMs: 60_000, max: 8 });
  const setSessionCookie = (res, sessionToken, { remote }) => {
    if (!sessionToken) return;
    const secure = remote ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `coffeejack_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=86400`,
    );
  };
  const clearSessionCookie = (res) => {
    res.setHeader(
      "Set-Cookie",
      "coffeejack_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    );
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    const host = req.headers.host ?? "";
    const nativeRemote = isNativeRemoteAccess(access);
    const remoteHostname = access?.hostname || null;
    const trust = classifyRequest(req, {
      accessHostname: remoteHostname,
      accessConfigured: Boolean(access),
    });
    const isLocal = trust.mode === "local";
    if (!isLocal)
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    let remoteIdentity = null;
    if (!isLocal) {
      if (!access)
        return json(res, 403, {
          error: "Remote authentication required",
          code: "access_not_configured",
        });
      const hostName = host.split(":")[0].toLowerCase();
      const accessHost = String(access.hostname).toLowerCase();
      // Public hostname must match; loopback+CF markers allowed only as tunnel rewrite.
      if (
        trust.reason !== "cloudflare_markers_on_loopback" &&
        hostName !== accessHost
      )
        return json(res, 403, { error: "Invalid host" });
      if (!nativeRemote) {
        const verified = await access.authorize(req);
        if (!verified) {
          const limited = remoteLimiter.check(
            req,
            REMOTE_RATE.loginDenied.category,
            REMOTE_RATE.loginDenied.max,
          );
          if (!limited.ok) {
            res.setHeader(
              "Retry-After",
              String(Math.ceil(limited.retryAfterMs / 1000) || 1),
            );
            return json(res, 429, { error: "Too many requests" });
          }
          audit(store, {
            action: "remote_login_denied",
            detail: { reason: "invalid_token", host: host.slice(0, 120) },
          });
          return json(res, 403, { error: "Remote authentication required" });
        }
        remoteIdentity = verified;
      }
    }
    // Spoofed CF email/identity headers never authorize — only verified JWT
    // claims (Cloudflare Access mode) or a CoffeeJack session (native mode).
    const expected = expectedOrigin(req, {
      mode: trust.mode,
      accessHostname: remoteHostname,
    });
    // Access redirects can retain cross-site Fetch Metadata. Only the verified
    // remote app entry document may cross that boundary; APIs and writes may not.
    const accessNavigation =
      Boolean(remoteIdentity) &&
      req.method === "GET" &&
      (req.url === "/" || req.url.startsWith("/?")) &&
      req.headers["sec-fetch-mode"] === "navigate" &&
      req.headers["sec-fetch-dest"] === "document";
    if (
      (req.headers.origin && req.headers.origin !== expected) ||
      (req.headers["sec-fetch-site"] === "cross-site" && !accessNavigation)
    )
      return json(res, 403, { error: "Cross-origin request denied" });
    const url = new URL(req.url, `http://${host || "127.0.0.1"}`);
    const route = url.pathname;
    if (route.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    const tooMany = (res, limited) => {
      if (limited.ok) return false;
      res.setHeader(
        "Retry-After",
        String(Math.ceil(limited.retryAfterMs / 1000) || 1),
      );
      json(res, 429, { error: "Too many requests" });
      return true;
    };
    try {
      let identity = route.startsWith("/api/")
        ? sessionIdentity(req)
        : undefined;
      const publicBase =
        !isLocal && remoteHostname
          ? `https://${remoteHostname}`
          : `http://${host || "127.0.0.1:3210"}`;
      const sessionExpired = () =>
        json(res, 401, {
          error: "Your session expired. Please log in again.",
          code: "session_expired",
        });
      const authenticationRequired = () =>
        json(res, 401, {
          error: "Authentication required. Please log in again.",
          code: "authentication_required",
        });
      if (route === "/api/auth/config" && req.method === "GET") {
        return json(res, 200, {
          mail: mailStatus(mail.env),
          publicRegistration: true,
          remoteAuth: nativeRemote
            ? "native"
            : access
              ? "cloudflare_access"
              : "disabled",
          publicHost: remoteHostname,
        });
      }
      if (route === "/api/auth/me" && req.method === "GET") {
        if (!identity?.user) return sessionExpired();
        return json(res, 200, {
          user: {
            ...publicUser(identity.user),
            email_verification_required: publicAccountNeedsVerification(
              identity.user,
            ),
          },
        });
      }
      if (route === "/api/auth/register" && req.method === "POST") {
        if (
          tooMany(
            res,
            authLimiter.check(req, AUTH_RATE.signup.category, AUTH_RATE.signup.max),
          )
        )
          return;
        const b = await body(req);
        const created = await registerAccount(
          store,
          {
            displayName: b.displayName,
            email: b.email,
            password: b.password,
            confirmPassword: b.confirmPassword,
            role: b.role,
          },
          { dataDirectory: data, mail, publicBase },
        );
        if (identity?.token) revokeSession(store, identity.token);
        const session = createSession(store, created.user.id, {
          source: isLocal ? "account" : "remote",
        });
        setSessionCookie(res, session.token, { remote: !isLocal });
        return json(res, 201, created);
      }
      if (route === "/api/auth/login" && req.method === "POST") {
        if (
          tooMany(
            res,
            authLimiter.check(req, AUTH_RATE.login.category, AUTH_RATE.login.max),
          )
        )
          return;
        const b = await body(req);
        const result = await authenticateAccount(store, {
          email: b.email,
          password: b.password,
        });
        if (!result.ok)
          return json(res, 401, { error: "Invalid email or password" });
        if (identity?.token) revokeSession(store, identity.token);
        const session = createSession(store, result.user.id, {
          source: isLocal ? "account" : "remote",
        });
        setSessionCookie(res, session.token, { remote: !isLocal });
        audit(store, {
          userId: result.user.id,
          action: "account_login",
          detail: { source: isLocal ? "local" : "remote" },
        });
        return json(res, 200, {
          user: publicUser(result.user),
        });
      }
      if (route === "/api/auth/logout" && req.method === "POST") {
        if (identity?.token) {
          revokeSession(store, identity.token);
          audit(store, {
            userId: identity.user?.id,
            action: "session_revoked",
            detail: { reason: "account_logout" },
          });
        }
        clearSessionCookie(res);
        return json(res, 200, { ok: true });
      }
      if (route === "/api/auth/forgot" && req.method === "POST") {
        if (
          tooMany(
            res,
            authLimiter.check(req, AUTH_RATE.reset.category, AUTH_RATE.reset.max),
          )
        )
          return;
        const b = await body(req);
        const result = await requestPasswordReset(store, b.email, {
          dataDirectory: data,
          mail,
          publicBase,
        });
        return json(res, 200, {
          message: result.message,
          mail: result.mail,
          ...(result.devToken ? { devToken: result.devToken } : {}),
        });
      }
      if (route === "/api/auth/reset" && req.method === "POST") {
        if (
          tooMany(
            res,
            authLimiter.check(req, AUTH_RATE.reset.category, AUTH_RATE.reset.max),
          )
        )
          return;
        const b = await body(req);
        await resetPassword(store, {
          email: b.email,
          code: b.code || b.token,
          password: b.password,
          confirmPassword: b.confirmPassword,
        });
        return json(res, 200, { ok: true });
      }
      if (route === "/api/auth/verify" && req.method === "POST") {
        if (
          tooMany(
            res,
            authLimiter.check(req, AUTH_RATE.verify.category, AUTH_RATE.verify.max),
          )
        )
          return;
        if (!identity?.user) return sessionExpired();
        const b = await body(req);
        const user = await verifyEmail(store, b.code || b.token, {
          user: identity.user,
        });
        return json(res, 200, { user });
      }
      if (route === "/api/auth/resend" && req.method === "POST") {
        if (
          tooMany(
            res,
            authLimiter.check(req, AUTH_RATE.verify.category, AUTH_RATE.verify.max),
          )
        )
          return;
        if (!identity?.user) return sessionExpired();
        const result = await resendVerification(store, identity.user, {
          dataDirectory: data,
          mail,
          publicBase,
        });
        return json(res, 200, result);
      }
      if (route === "/api/auth/owner/credentials" && req.method === "POST") {
        const actor = identity?.user;
        if (!actor || actor.role !== ROLES.OWNER)
          return json(res, 403, { error: "Owner credentials denied" });
        const b = await body(req);
        const user = await attachOwnerCredentials(store, actor, {
          email: b.email,
          password: b.password,
          confirmPassword: b.confirmPassword,
        });
        return json(res, 200, { user });
      }
      // Remote: Cloudflare-verified identity must map to the session user.
      // Never let a stolen local session token impersonate another CF subject.
      if (!isLocal && remoteIdentity && route.startsWith("/api/")) {
        if (route === "/api/status" && !identity) {
          const limited = remoteLimiter.check(
            req,
            REMOTE_RATE.statusSession.category,
            REMOTE_RATE.statusSession.max,
          );
          if (!limited.ok) {
            res.setHeader(
              "Retry-After",
              String(Math.ceil(limited.retryAfterMs / 1000) || 1),
            );
            return json(res, 429, { error: "Too many requests" });
          }
        }
        const ownerEmails = (
          process.env.CF_ACCESS_OWNER_EMAIL ||
          process.env.CF_ACCESS_ALLOWED_EMAILS ||
          ""
        )
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean);
        const mapped = resolveExternalIdentity(store, remoteIdentity, {
          ownerAutoLinkEmails: ownerEmails.slice(0, 1),
          autoCreateRole:
            route === "/api/status" &&
            !identity &&
            process.env.CF_ACCESS_AUTO_CREATE_ROLE === "standard"
              ? "standard"
              : null,
        });
        if (mapped.status === "pending") {
          if (identity?.token) {
            revokeSession(store, identity.token);
            audit(store, {
              userId: identity.user?.id,
              action: "session_revoked",
              detail: { reason: "unmapped_identity" },
            });
          }
          audit(store, {
            action: "remote_login_denied",
            detail: { reason: "unmapped_identity" },
          });
          if (route === "/api/status")
            return json(res, 403, {
              error: "Access pending",
              code: "pending_identity",
              email: mapped.email || remoteIdentity.email || null,
            });
          return json(res, 403, { error: "Remote authentication required" });
        }
        if (mapped.status !== "mapped" || !mapped.user) {
          if (identity?.token) {
            revokeSession(store, identity.token);
            audit(store, {
              userId: identity.user?.id,
              action: "session_revoked",
              detail: { reason: mapped.reason || "denied" },
            });
          }
          audit(store, {
            action: "remote_login_denied",
            detail: { reason: mapped.reason || "denied" },
          });
          return json(res, 403, { error: "Remote authentication required" });
        }
        if (identity && identity.user.id !== mapped.user.id) {
          if (identity.token) {
            revokeSession(store, identity.token);
            audit(store, {
              userId: identity.user.id,
              action: "session_revoked",
              detail: { reason: "identity_mismatch" },
            });
          }
          audit(store, {
            userId: identity.user.id,
            action: "remote_login_denied",
            detail: { reason: "identity_mismatch" },
          });
          return json(res, 403, { error: "Remote authentication required" });
        }
        // Role/status changes apply on every request via fresh getUser.
        if (identity)
          identity = {
            ...identity,
            user: getUser(store, mapped.user.id) || mapped.user,
          };
        if (!identity && route === "/api/status") {
          const remoteSession = createSession(store, mapped.user.id, {
            source: "remote",
          });
          audit(store, {
            userId: mapped.user.id,
            action: "remote_login",
            detail: { provider: IDENTITY_PROVIDER },
          });
          identity = {
            token: remoteSession.token,
            user: getUser(store, mapped.user.id),
            session: getSession(store, remoteSession.token),
          };
          setSessionCookie(res, remoteSession.token, { remote: true });
        } else if (!identity) {
          return json(res, 403, { error: "Invalid session token" });
        }
      }
      if (route === "/api/status" && req.method === "GET") {
        if (!identity) {
          if (!isLocal && !nativeRemote)
            return json(res, 403, { error: "Remote authentication required" });
          return authenticationRequired();
        }
        const user = identity.user;
        if (user.role !== "owner")
          await ensureUserWorkspace(store, user.id, data);
        const workspaces = listWorkspacesForUser(store, user.id).map((w) => ({
          id: w.id,
          name: w.name,
          status: w.status,
          owner: w.owner_user_id === user.id,
        }));
        const activeWs = await resolveActiveWorkspace(store, user, {
          dataDirectory: data,
          root,
        });
        let models = [],
          modelError = "";
        let localModelPlan = null;
        try {
          models = await ollama.models();
        } catch (e) {
          modelError = e.message;
        }
        let providers = [];
        try {
          await registry.refresh();
          providers = registry.listProviders().map((p) => ({
            ...p,
            status: !p.enabled
              ? "not_configured"
              : p.available
                ? "connected"
                : "unavailable",
          }));
          const catalog = registry.listModels({
            remoteAllowed:
              getPreferences(store, user.id).remoteAi !== "never",
          });
          if (catalog.length)
            models = catalog.map((m) => ({
              name: m.id,
              provider: m.provider,
              local: m.local !== false,
              label: `${m.id} · ${m.provider}${m.local === false ? " · Remote" : " · Local"}`,
            }));
          localModelPlan = resolveLocalModelPlan(
            models.filter((m) => m.local !== false).map((m) => m.name),
          );
        } catch {
          /* keep ollama models */
        }
        if (!localModelPlan) {
          localModelPlan = resolveLocalModelPlan(
            (models || []).map((m) => m.name || m.id).filter(Boolean),
          );
        }
        const identities = findIdentitiesForUser(store, user.id);
        if (!isLocal) setSessionCookie(res, identity.token, { remote: true });
        return json(res, 200, {
          token: identity.token,
          user: {
            id: user.id,
            display_name: user.display_name,
            role: user.role,
            status: user.status,
            email: user.email || null,
            email_verified: Boolean(user.email_verified),
            email_verification_required: publicAccountNeedsVerification(user),
          },
          identitySource: !isLocal
            ? "cloudflare"
            : identity.session?.source === "account"
              ? "account"
              : "local",
          identities: identities.map((i) => ({
            provider: i.provider,
            email: i.normalized_email,
            linked: true,
          })),
          permissions: permissionSummary(user),
          models,
          providers,
          localModels: localModelPlan,
          autoRouting: localModelPlan
            ? {
                provider: "ollama",
                general: localModelPlan.general,
                reasoning: localModelPlan.reasoning,
                fallback: localModelPlan.fallback,
              }
            : null,
          modelError,
          settings: {
            ...settings(),
            workspace:
              user.role === "owner" || user.role === "trusted"
                ? activeWs.root_path
                : activeWs.name,
          },
          workspaces,
          activeWorkspace: {
            id: activeWs.id,
            name: activeWs.name,
          },
          preferences: getPreferences(store, user.id),
          gaming,
          autoGaming,
          busy: Boolean(active),
          jack: selfModel(store, {
            active: Boolean(active),
            gaming,
            userId: user.id,
          }),
          approvals: [...approvals.values()]
            .filter((pending) => pending.userId === user.id)
            .map(({ id, name, args, consequence }) => ({
              id,
              name,
              args,
              ...(consequence ? { consequence } : {}),
            })),
          selfRepair: {
            settings: selfRepair.settings(),
            canApply: canSelfRepair(user),
            canDiagnose: canDiagnoseSelfRepair(user),
          },
        });
      }
      if (route.startsWith("/api/") && !identity)
        return json(res, 403, { error: "Invalid session token" });
      const user = identity?.user;
      if (
        publicAccountNeedsVerification(user) &&
        route !== "/api/session/logout" &&
        !route.startsWith("/api/auth/")
      )
        return json(res, 403, {
          error: "Email verification required",
          code: "email_unverified",
        });
      if (route === "/api/users" && req.method === "GET") {
        const users = canManageUsers(user)
          ? listUsers(store)
          : [getUser(store, user.id)];
        return json(
          res,
          200,
          users.map((u) => ({
            ...u,
            identities: findIdentitiesForUser(store, u.id).map((i) => ({
              provider: i.provider,
              email: i.normalized_email,
            })),
          })),
        );
      }
      if (route === "/api/users" && req.method === "POST") {
        if (!canManageUsers(user))
          return json(res, 403, { error: "User management denied" });
        const b = await body(req);
        // An accidental role selection must not silently grant owner access.
        if (String(b.role ?? "").toLowerCase() === ROLES.OWNER &&
            b.confirmOwner !== true)
          return json(res, 400, { error: "Owner creation requires explicit confirmation" });
        const created = createUser(store, {
          displayName: b.displayName,
          role: b.role,
        });
        await ensureUserWorkspace(store, created.id, data);
        audit(store, {
          userId: user.id,
          action: "user_created",
          detail: { targetUserId: created.id, role: created.role },
        });
        return json(res, 201, created);
      }
      if (route.startsWith("/api/users/") && req.method === "PATCH") {
        if (!canManageUsers(user))
          return json(res, 403, { error: "User management denied" });
        const id = route.split("/").pop();
        const current = getUser(store, id);
        if (!current) return json(res, 404, { error: "User not found" });
        const b = await body(req);
        const removesOwner =
          current.role === ROLES.OWNER &&
          (b.role !== undefined && b.role !== ROLES.OWNER ||
            b.status === "disabled");
        if (removesOwner) {
          const ownerCount = listUsers(store).filter(
            (item) =>
              item.role === ROLES.OWNER && item.status === "active",
          ).length;
          if (ownerCount <= 1)
            return json(res, 409, { error: "Cannot demote the last owner" });
        }
        const updated =
          b.status === "disabled"
            ? disableUser(store, id)
            : updateUser(store, id, {
                displayName: b.displayName,
                role: b.role,
                status: b.status,
              });
        audit(store, {
          userId: user.id,
          action: "user_updated",
          detail: {
            targetUserId: id,
            role: updated.role,
            status: updated.status,
          },
        });
        return json(res, 200, updated);
      }
      if (route === "/api/session/switch" && req.method === "POST") {
        // Cloudflare-bound remote sessions must not impersonate another local user.
        if (!isLocal)
          return json(res, 403, {
            error:
              "Local-only users cannot be switched into from a Cloudflare-authenticated session. Open CoffeeJack locally at http://127.0.0.1:3210 to switch users.",
            code: "remote_switch_denied",
          });
        if (!canManageUsers(user))
          return json(res, 403, { error: "Profile switching denied" });
        const b = await body(req);
        const target = getUser(store, b.userId);
        if (!target || target.status !== "active")
          return json(res, 404, { error: "Active user not found" });
        const next = createSession(store, target.id, { source: "local" });
        if (target.role === "owner")
          await ensureOwnerWorkspace(store, { root, dataDirectory: data });
        else await ensureUserWorkspace(store, target.id, data);
        audit(store, {
          userId: user.id,
          action: "profile_switched",
          detail: { targetUserId: target.id },
        });
        return json(res, 200, {
          token: next.token,
          user: target,
        });
      }
      if (route === "/api/session/logout" && req.method === "POST") {
        if (identity?.token) {
          revokeSession(store, identity.token);
          audit(store, {
            userId: identity.user?.id,
            action: "session_revoked",
            detail: { reason: "logout" },
          });
        }
        clearSessionCookie(res);
        return json(res, 200, { ok: true });
      }
      if (route === "/api/identity/link" && req.method === "POST") {
        if (!canManageUsers(user))
          return json(res, 403, { error: "Identity linking denied" });
        if (!isLocal) {
          const limited = remoteLimiter.check(
            req,
            REMOTE_RATE.identityLink.category,
            REMOTE_RATE.identityLink.max,
          );
          if (!limited.ok) {
            res.setHeader(
              "Retry-After",
              String(Math.ceil(limited.retryAfterMs / 1000) || 1),
            );
            return json(res, 429, { error: "Too many requests" });
          }
        }
        const b = await body(req);
        const linked = linkExternalIdentity(store, {
          provider: b.provider || IDENTITY_PROVIDER,
          subject: b.subject || b.email,
          email: b.email,
          userId: b.userId || user.id,
          actorUserId: user.id,
        });
        return json(res, 200, {
          id: linked.id,
          provider: linked.provider,
          email: linked.normalized_email,
        });
      }
      if (route === "/api/workspaces" && req.method === "GET") {
        return json(res, 200, {
          workspaces: listWorkspacesForUser(store, user.id).map((w) => ({
            id: w.id,
            name: w.name,
            status: w.status,
            owner: w.owner_user_id === user.id,
          })),
        });
      }
      if (route === "/api/workspaces/active" && req.method === "POST") {
        const b = await body(req);
        if (!userCanAccessWorkspace(store, user.id, b.workspaceId)) {
          audit(store, {
            userId: user.id,
            action: "workspace_access_denied",
            detail: { workspaceId: b.workspaceId },
          });
          return json(res, 403, { error: "Workspace access denied" });
        }
        if (b.chatId)
          setChatWorkspace(store, b.chatId, b.workspaceId, user.id);
        store.set(`activeWorkspace:${user.id}`, b.workspaceId);
        const ws = getWorkspace(store, b.workspaceId);
        return json(res, 200, {
          activeWorkspace: { id: ws.id, name: ws.name },
        });
      }
      if (route === "/api/chats" && req.method === "GET")
        return json(res, 200, store.chats(user.id));
      if (route.startsWith("/api/chats/") && req.method === "GET") {
        const id = route.split("/").pop();
        if (!store.chat(id, user.id))
          return json(res, 404, { error: "Chat not found" });
        return json(res, 200, store.messages(id));
      }
      if (route.startsWith("/api/chats/") && req.method === "DELETE") {
        const id = route.split("/").pop();
        if (active?.chatId === id)
          return json(res, 409, { error: "Stop the active chat first" });
        if (!store.deleteChat(id, user.id))
          return json(res, 404, { error: "Chat not found" });
        return json(res, 200, { ok: true });
      }
      if (route === "/api/memories" && req.method === "GET") {
        const rows = store
          .memories(url.searchParams.get("q") ?? "", user.id)
          .map((m) => ({
            ...m,
            category: m.category || memoryCategory(m.kind, m.content),
          }));
        return json(res, 200, rows);
      }
      if (route === "/api/memories" && req.method === "POST") {
        const b = await body(req);
        if (typeof b.content !== "string" || !b.content.trim())
          throw new Error("Memory is empty");
        return json(res, 200, {
          id: store.remember(b.content, b.kind ?? "note", workspace, {
            userId: user.id,
          }),
        });
      }
      if (route.startsWith("/api/memories/") && req.method === "DELETE") {
        return json(res, 200, {
          ok: store.forget(route.split("/").pop(), user.id),
        });
      }
      if (route.startsWith("/api/memory-proposals/") && req.method === "POST") {
        const id = route.split("/").pop();
        const b = await body(req);
        if (!["save", "discard", "edit"].includes(b.action))
          throw new Error("Invalid memory proposal action");
        if (
          b.action === "edit" &&
          (typeof b.content !== "string" || !b.content.trim())
        )
          throw new Error("Edited memory must contain text");
        const proposal = memoryProposals.get(id);
        if (!proposal || proposal.userId !== user.id)
          return json(res, 404, { error: "Memory proposal expired" });
        const result = memoryProposals.resolve(id, b.action, b.content);
        return json(res, 200, result);
      }
      if (route === "/api/self-repair" && req.method === "GET") {
        const settings = selfRepair.settings();
        return json(res, 200, {
          settings,
          canApply: canSelfRepair(user),
          canDiagnose: canDiagnoseSelfRepair(user),
          history: user.role === "owner" ? selfRepair.history() : [],
          pending:
            user.role === "owner"
              ? selfRepair.listPending()
              : selfRepair.listPending().filter((p) => p.userId === user.id),
        });
      }
      if (route === "/api/self-repair" && req.method === "POST") {
        if (user.role !== "owner")
          return json(res, 403, { error: "Only the Owner can change Self Repair settings" });
        const b = await body(req);
        return json(res, 200, { settings: selfRepair.saveSettings(b) });
      }
      if (route.startsWith("/api/self-repair/") && req.method === "POST") {
        const id = route.split("/").pop();
        const b = await body(req);
        const action = b.action;
        if (action === "cancel") {
          return json(res, 200, await selfRepair.cancel(id, user));
        }
        if (action === "attach_patches") {
          if (!canSelfRepair(user))
            return json(res, 403, { error: "Only the Owner can attach patches" });
          return json(res, 200, {
            proposal: selfRepair.attachPatches(id, user, b.patches),
          });
        }
        if (action === "apply") {
          if (!canSelfRepair(user))
            return json(res, 403, { error: "Only the Owner can apply Self Repair" });
          const result = await selfRepair.apply(id, user, {
            acknowledgeSecurity: b.acknowledgeSecurity === true,
          });
          return json(res, result.ok ? 200 : 409, result);
        }
        if (action === "diagnose") {
          if (!canDiagnoseSelfRepair(user))
            return json(res, 403, { error: "Diagnosis not allowed for this role" });
          const result = await selfRepair.diagnose({
            text: String(b.text || ""),
            chatId: b.chatId || null,
            user,
            historyMessages: b.chatId ? store.messages(b.chatId) : [],
          });
          return json(res, 200, result);
        }
        throw new Error("Invalid self-repair action");
      }
      if (route === "/api/security-lab" || route.startsWith("/api/security-lab/")) {
        if (user.role !== "owner")
          return json(res, 403, { error: "Security Lab is visible only to Owner" });
        const lab = createLabToolkit({ dataDirectory: data, user });
        if (route === "/api/security-lab" && req.method === "GET") {
          return json(res, 200, await lab.snapshot());
        }
        if (route === "/api/security-lab/targets" && req.method === "GET") {
          return json(res, 200, { targets: lab.registry.list() });
        }
        if (route === "/api/security-lab/targets" && req.method === "POST") {
          const b = await body(req);
          const target = await lab.registry.add(b.target || b, user);
          return json(res, 200, { target });
        }
        if (route.startsWith("/api/security-lab/targets/") && req.method === "DELETE") {
          const targetId = decodeURIComponent(route.slice("/api/security-lab/targets/".length));
          return json(res, 200, await lab.registry.remove(targetId, user));
        }
        if (route === "/api/security-lab/run" && req.method === "POST") {
          const b = await body(req);
          return json(res, 200, await lab.execute("security_lab", { ...b, action: "run" }));
        }
        if (route === "/api/security-lab/stop" && req.method === "POST") {
          return json(res, 200, await lab.execute("security_lab", { action: "stop" }));
        }
        if (route === "/api/security-lab/lessons" && req.method === "GET") {
          return json(res, 200, { lessons: lab.lessons.list() });
        }
        if (route === "/api/security-lab/lessons/clear" && req.method === "POST") {
          return json(res, 200, await lab.lessons.clear(user));
        }
        if (route === "/api/security-lab/findings" && req.method === "GET") {
          return json(res, 200, await lab.execute("security_lab", { action: "findings" }));
        }
        if (route === "/api/security-lab/matrix" && req.method === "POST") {
          const b = await body(req);
          return json(res, 200, await lab.execute("security_lab", { action: "matrix", ...b }));
        }
        if (route === "/api/security-lab/availability" && req.method === "GET") {
          return json(res, 200, await lab.execute("security_lab", { action: "availability" }));
        }
        if (route.startsWith("/api/security-lab/report/") && req.method === "GET") {
          const runId = decodeURIComponent(route.slice("/api/security-lab/report/".length));
          return json(res, 200, await lab.execute("security_lab", { action: "report", run_id: runId }));
        }
        return json(res, 404, { error: "Unknown Security Lab route" });
      }
      if (route === "/api/events" && req.method === "GET")
        return json(res, 200, store.events(user.id));
      if (route === "/api/preferences" && req.method === "GET")
        return json(res,200,{preferences:getPreferences(store,user.id),catalog:{languages:ASSISTANT_LANGUAGES||LANGUAGES,appLanguages:APP_LANGUAGES,modes:MODES,packs:PACKS,options:PREFERENCE_OPTIONS,memoryBehaviors:MEMORY_BEHAVIORS}});
      if (route === "/api/providers" && req.method === "GET") {
        await registry.refresh();
        const prefs = getPreferences(store, user.id);
        return json(res, 200, {
          providers: registry.listProviders().map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
            privacyClass: p.privacyClass,
            enabled: p.enabled,
            available: Boolean(p.available),
            modelCount: p.modelCount,
            lastSuccessAt: p.lastSuccessAt || null,
            lastFailureAt: p.lastFailureAt || null,
            latencyMs: p.latencyMs ?? null,
            error: p.error || null,
            status: !p.enabled
              ? "not_configured"
              : p.available
                ? "connected"
                : "unavailable",
          })),
          models: registry.listModels({
            remoteAllowed: prefs.remoteAi !== "never",
          }),
          preferences: {
            councilMode: prefs.councilMode,
            remoteAi: prefs.remoteAi,
            councilMaxModels: prefs.councilMaxModels,
            remoteBudget: prefs.remoteBudget,
            councilOtherModels: prefs.councilOtherModels,
          },
        });
      }
      if (route === "/api/preferences" && req.method === "POST") {
        if(active)return json(res,409,{error:"Stop the active task before changing preferences"});
        return json(res,200,savePreferences(store,await body(req),user.id));
      }
      if (route === "/api/persona" && req.method === "GET")
        return json(
          res,
          200,
          selfModel(store, {
            active: Boolean(active),
            gaming,
            userId: user.id,
          }),
        );
      if (route === "/api/persona" && req.method === "POST") {
        const input = validatePersona(await body(req));
        if (active)
          return json(res, 409, {
            error: "أوقف المهمة الحالية قبل تعديل شخصية Jack.",
          });
        store.set("persona", { ...getPersona(store), ...input });
        const preferencePatch={};
        if(input.language)preferencePatch.language=input.language;
        if(input.humor)preferencePatch.humor=({off:"off",subtle:"dry",playful:"dark"})[input.humor];
        if(input.detail)preferencePatch.verbosity=({concise:"concise",balanced:"normal",thorough:"detailed"})[input.detail];
        savePreferences(store,preferencePatch,user.id);
        return json(res, 200, selfModel(store, { active: false, gaming, userId: user.id }));
      }
      if (route === "/api/settings" && req.method === "POST") {
        if (active)
          return json(res, 409, {
            error: "Stop the current task before changing settings",
          });
        const b = await body(req);
        for (const key of [
          "model",
          "codingModel",
          "visionModel",
          "instructions",
        ])
          if (key in b && (typeof b[key] !== "string" || b[key].length > 8000))
            throw new Error("Invalid setting");
        for (const key of ["autoApprove", "autoGaming"])
          if (key in b && typeof b[key] !== "boolean")
            throw new Error("Invalid toggle");
        if (
          "gameProcesses" in b &&
          (!Array.isArray(b.gameProcesses) ||
            b.gameProcesses.length > 100 ||
            b.gameProcesses.some(
              (p) => typeof p !== "string" || !/^[\w .-]+\.exe$/i.test(p),
            ))
        )
          throw new Error("Invalid game executable names");
        if ("workspace" in b) {
          if (user.role !== "owner")
            return json(res, 403, {
              error: "Only owner can change the primary workspace path",
            });
          if (typeof b.workspace !== "string" || !path.isAbsolute(b.workspace))
            throw new Error("Workspace must be an absolute path");
          const stat = await fs.stat(b.workspace);
          if (!stat.isDirectory())
            throw new Error("Workspace must be a folder");
          workspace = await fs.realpath(b.workspace);
          tools.workspace = workspace;
          store.set("workspace", workspace);
          const ownerWorkspace = listWorkspacesForUser(store, owner.id)[0];
          if (ownerWorkspace)
            updateWorkspaceRoot(store, ownerWorkspace.id, workspace);
        }
        for (const key of [
          "model",
          "codingModel",
          "visionModel",
          "instructions",
          "autoApprove",
          "gameProcesses",
          "autoGaming",
        ])
          if (key in b) store.set(key, b[key]);
        return json(res, 200, settings());
      }
      if (route === "/api/gaming" && req.method === "POST") {
        if (!canToggleGaming(user))
          return json(res, 403, { error: "Gaming mode permission denied" });
        const b = await body(req);
        if (typeof b.enabled !== "boolean") throw new Error("Invalid mode");
        autoGaming = false;
        const unloaded = await setGaming(b.enabled);
        audit(store, {
          userId: user.id,
          action: "gaming_toggled",
          detail: { enabled: b.enabled },
        });
        return json(res, 200, { gaming, unloaded });
      }
      if (route === "/api/stop" && req.method === "POST") {
        if (active && active.userId !== user.id)
          return json(res, 403, { error: "Stop denied for another user's task" });
        active?.controller.abort();
        return json(res, 200, { ok: true });
      }
      if (route.startsWith("/api/approve/") && req.method === "POST") {
        if (!isLocal) {
          const limited = remoteLimiter.check(
            req,
            REMOTE_RATE.approval.category,
            REMOTE_RATE.approval.max,
          );
          if (!limited.ok) {
            res.setHeader(
              "Retry-After",
              String(Math.ceil(limited.retryAfterMs / 1000) || 1),
            );
            return json(res, 429, { error: "Too many requests" });
          }
        }
        const b = await body(req);
        const pending = approvals.get(route.split("/").pop());
        if (!pending || pending.userId !== user.id)
          return json(res, 404, { error: "Approval expired" });
        const allowed = b.allow === true;
        audit(store, {
          userId: user.id,
          action: allowed ? "approval_accepted" : "approval_rejected",
          detail: { approvalId: pending.id, tool: pending.name },
        });
        pending.finish(allowed);
        return json(res, 200, { ok: true });
      }
      if (route === "/api/upload" && req.method === "POST") {
        const b = await body(req);
        if (typeof b.name !== "string" || typeof b.data !== "string")
          throw new Error("Invalid upload");
        const ext = path.extname(b.name).toLowerCase();
        if (
          ![
            ".txt",
            ".md",
            ".csv",
            ".tsv",
            ".json",
            ".js",
            ".ts",
            ".py",
            ".html",
            ".css",
            ".pdf",
            ".docx",
            ".xlsx",
            ".png",
            ".jpg",
            ".jpeg",
            ".webp",
          ].includes(ext)
        )
          throw new Error("Unsupported attachment type");
        const buffer = Buffer.from(b.data, "base64");
        if (buffer.length > 20 * 1024 * 1024) throw new Error("20 MB maximum");
        const name = `${randomUUID()}-${path.basename(b.name).replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
        const uploadWs = await resolveActiveWorkspace(store, user, {
          chatId: b.chatId || null,
          dataDirectory: data,
          root,
        });
        const destination = await workspacePath(
          uploadWs.root_path,
          `uploads/${name}`,
          { write: true },
        );
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, buffer);
        return json(res, 200, { path: `uploads/${name}`, name: b.name });
      }
      if (route === "/api/chat" && req.method === "POST") {
        const chatAuth = authorize({ user, capability: "chat" });
        if (chatAuth.decision !== "allow")
          return json(res, 403, {
            error: chatAuth.reason || "Chat denied",
            code: publicAccountNeedsVerification(user)
              ? "email_unverified"
              : "capability_denied",
          });
        if (user.role === "standard") {
          if (
            tooMany(
              res,
              authLimiter.check(
                req,
                AUTH_RATE.chatStandard.category,
                AUTH_RATE.chatStandard.max,
                user.id,
              ),
            )
          )
            return;
        }
        if (gaming)
          return json(res, 409, {
            error: "وضع الألعاب مفعّل. أوقفه لبدء المحادثة.",
          });
        if (active) return json(res, 409, { error: "هناك مهمة قيد التنفيذ." });
        const b = await body(req);
        if (
          typeof b.text !== "string" ||
          !b.text.trim() ||
          b.text.length > 30000
        )
          throw new Error("Message must contain 1–30000 characters");
        if (
          b.attachments &&
          (!Array.isArray(b.attachments) ||
            b.attachments.length > 5 ||
            b.attachments.some((v) => typeof v !== "string"))
        )
          throw new Error("Invalid attachments");
        // Requests can interleave while their body is arriving.
        if (active || gaming)
          return json(res, 409, {
            error: "المهمة مشغولة أو وضع الألعاب مفعّل.",
          });
        const chat = b.chatId
          ? store.chat(b.chatId, user.id)
          : null;
        if (b.chatId && !chat) throw new Error("Chat not found");
        const activeWs = await resolveActiveWorkspace(store, user, {
          chatId: chat?.id || null,
          dataDirectory: data,
          root,
        });
        if (!userCanAccessWorkspace(store, user.id, activeWs.id)) {
          audit(store, {
            userId: user.id,
            action: "workspace_access_denied",
            detail: { workspaceId: activeWs.id },
          });
          throw new Error("Workspace access denied");
        }
        const boundChat =
          chat || store.createChat(b.text, user.id, activeWs.id);
        if (!getChatWorkspaceId(store, boundChat.id))
          setChatWorkspace(store, boundChat.id, activeWs.id, user.id);
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        const emit = (event) => {
          if (!res.destroyed) res.write(JSON.stringify(event) + "\n");
        };
        const controller = new AbortController();
        let finish;
        const finished = new Promise((resolve) => {
          finish = resolve;
        });
        const previousToolsWorkspace = tools.workspace;
        tools.workspace = activeWs.root_path;
        tools.setArtifactContext({
          userId: user.id,
          workspaceId: activeWs.id,
          chatId: boundChat.id,
        });
        active = {
          controller,
          chatId: boundChat.id,
          emit,
          finished,
          userId: user.id,
          workspaceId: activeWs.id,
        };
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
        });
        emit({
          type: "chat",
          chat: boundChat,
          workspace: { id: activeWs.id, name: activeWs.name },
        });
        const conf = settings();
        const timing = createTurnTiming();
        try {
          const preferences = {
            ...getPreferences(store, user.id),
            ...(user.role === "guest" ? { remoteAi: "never" } : {}),
          };
          const history = store.messages(boundChat.id);
          const previousState = store.taskState(boundChat.id);
          const previousStyle = previousState?.style || null;
          const previousTopic = previousState?.canonicalTopic || null;
          // PRE-ROUTING: dialect understanding then priority lanes then follow-ups.
          const previousSpeakerPersona = previousState?.speakerPersona || null;
          const turn = resolveTurnContext(b.text, {
            history,
            user,
            previousStyle,
            previousTopic,
            previousSpeakerPersona,
            store,
          });
          timing.mark("context_resolved");
          if (isPureGreeting(b.text)) {
            emitInstantGreeting({
              store,
              chatId: boundChat.id,
              user,
              text: b.text,
              emit,
              timing,
            });
          } else {
          const conversationIntent = turn;
          const routingText = turn.effectiveIntent || b.text;
          const requestedMode =
            typeof b.requestedMode === "string" && b.requestedMode
              ? b.requestedMode
              : preferences.mode;
          const modeInfo =
            turn.priorityLane === "self_repair" || turn.priorityLane === "persona"
              ? {
                  requestedMode,
                  effectiveMode: "auto",
                  reason:
                    turn.priorityLane === "self_repair"
                      ? "self_repair_priority"
                      : "persona_priority",
                  hybrid: [],
                }
              : resolveEffectiveMode({
                  requestedMode,
                  text: routingText,
                  attachments: b.attachments ?? [],
                  history,
                });
          const requestedModel =
            typeof b.requestedModel === "string" && b.requestedModel
              ? b.requestedModel
              : preferences.model || "auto";
          const taskMode =
            b.mode && ["general", "coding", "vision"].includes(b.mode)
              ? b.mode
              : "auto";
          // Fast path only for ordinary greetings — never for Self Repair / persona.
          const useFastPath =
            turn.fastPath === true && turn.priorityLane !== "self_repair";
          let selfRepairProposal = null;
          let selfRepairDiagnosis = null;
          const repairSettings = selfRepair.settings();
          // Self Repair is a priority lane: diagnose before routing/memory/tools.
          if (
            (turn.priorityLane === "self_repair" ||
              isSelfRepairComplaint(b.text)) &&
            repairSettings.enabled &&
            repairSettings.autoDiagnose &&
            canDiagnoseSelfRepair(user)
          ) {
            const diagnosed = await selfRepair.diagnose({
              text: b.text,
              chatId: boundChat.id,
              user,
              historyMessages: history,
            });
            if (diagnosed.ok && diagnosed.kind === "diagnosis" && diagnosed.diagnosis) {
              selfRepairDiagnosis = diagnosed.diagnosis;
              emit({
                type: "self_repair",
                kind: "diagnosis",
                diagnosis: diagnosed.diagnosis,
              });
            } else if (diagnosed.ok && diagnosed.proposal) {
              selfRepairProposal = diagnosed.proposal;
              emit({
                type: "self_repair",
                kind: "proposal",
                proposal: diagnosed.proposal,
              });
            }
          }
          const routing = await routeModel({
            ollama,
            registry,
            settings: conf,
            text: routingText,
            mode: taskMode,
            attachments: b.attachments ?? [],
            history:
              turn.resetTaskState || turn.priorityLane === "persona"
                ? []
                : history,
            signal: controller.signal,
            requestedModel: requestedModel || "auto",
            effectiveMode: modeInfo.effectiveMode,
            gaming,
            preferences,
            fastPath: useFastPath,
            conversationStyle: turn.conversationStyle || null,
            turnIntent: turn.intent || null,
            priorityLane: turn.priorityLane || null,
          });
          timing.mark("routing_done");
          emit({
            type: "priority",
            lane: turn.priorityLane || "normal",
            intent: turn.intent,
            personaKind: turn.personaKind || null,
            fastPath: useFastPath,
          });
          emit({
            type: "turn_context",
            intent: turn.intent,
            taskHint: turn.taskHint || null,
            fastPath: useFastPath,
            effectiveIntent: String(turn.effectiveIntent || "").slice(0, 400),
            transientFacts: (turn.snapshot?.transientFacts || []).slice(0, 6),
            hasThreadContext: Boolean(turn.threadContext),
            languageSwitch: turn.languageSwitch || null,
            conversationStyle: turn.conversationStyle || null,
            styleChanged: Boolean(turn.styleChanged),
            canonicalTopic: turn.canonicalTopic || null,
            semanticKind: turn.semantic?.kind || null,
            speakerPersona: turn.speakerPersona || null,
          });
          if (routing.needsRemoteApproval) {
            // Remote Ask: require an approval-shaped gate before prepare/chat.
            await new Promise((resolve, reject) => {
              const id = randomUUID();
              const finish = (allowed) => {
                clearTimeout(timer);
                approvals.delete(id);
                allowed
                  ? resolve()
                  : reject(new Error("Remote AI use declined"));
              };
              const timer = setTimeout(() => finish(false), 300000);
              approvals.set(id, {
                id,
                name: "remote_ai",
                args: {
                  provider: routing.provider,
                  model: routing.model,
                },
                finish,
                userId: user.id,
              });
              emit({
                type: "approval",
                id,
                name: "remote_ai",
                args: { provider: routing.provider, model: routing.model },
              });
            });
          }
          emit({
            type: "routing",
            model: routing.model,
            kind: routing.kind,
            fallback: routing.fallback,
            reason: routing.reason,
            reasonCode: routing.reasonCode,
            provider: routing.provider || "ollama",
            requestedModel: routing.requestedModel,
            effectiveModel: routing.effectiveModel,
            requestedMode: modeInfo.requestedMode,
            effectiveMode: modeInfo.effectiveMode,
            conversationIntent: conversationIntent.intent,
            taskHint: turn.taskHint,
            fastPath: useFastPath,
            autoRouting: routing.localPlan
              ? {
                  general: routing.localPlan.general,
                  reasoning: routing.localPlan.reasoning,
                }
              : undefined,
          });
          // Provider-native Council — skipped entirely on fast path (no probe, no UI card).
          let councilResult = null;
          let councilPlan = null;
          if (!useFastPath) {
            timing.mark("council_start");
            try {
              await registry.refresh(controller.signal);
              const available = registry.listModels({
                remoteAllowed: preferences.remoteAi !== "never" && !gaming,
                localOnly:
                  preferences.remoteAi === "never" ||
                  preferences.remoteBudget === "off" ||
                  gaming,
              });
              const locked =
                requestedModel && requestedModel !== "auto"
                  ? requestedModel
                  : null;
              councilPlan = buildCouncilPlan({
                text: routingText,
                preferences:
                  !turn.allowResearch || turn.conversational
                    ? { ...preferences, councilMode: "off" }
                    : preferences,
                gaming,
                effectiveMode: modeInfo.effectiveMode,
                taskKind: routing.kind,
                availableModels: available,
                lockedModel: locked,
                effectiveModel: routing.effectiveModel,
                healthLookup: (providerId, modelId) =>
                  registry.getModelHealth(providerId, modelId),
              });
              if (councilPlan.enabled) {
                const needsRemoteCouncil =
                  preferences.remoteAi === "ask" &&
                  councilPlan.participants.some((p) => !p.local);
                if (needsRemoteCouncil && !routing.needsRemoteApproval) {
                  await new Promise((resolve, reject) => {
                    const id = randomUUID();
                    const finishAsk = (allowed) => {
                      clearTimeout(timer);
                      approvals.delete(id);
                      allowed
                        ? resolve()
                        : reject(new Error("Remote AI use declined"));
                    };
                    const timer = setTimeout(() => finishAsk(false), 300000);
                    approvals.set(id, {
                      id,
                      name: "remote_ai",
                      args: {
                        purpose: "council",
                        models: councilPlan.participants
                          .filter((p) => !p.local)
                          .map((p) => `${p.providerId}/${p.modelId}`),
                      },
                      finish: finishAsk,
                      userId: user.id,
                    });
                    emit({
                      type: "approval",
                      id,
                      name: "remote_ai",
                      args: {
                        purpose: "council",
                        models: councilPlan.participants
                          .filter((p) => !p.local)
                          .map((p) => `${p.providerId}/${p.modelId}`),
                      },
                    });
                  });
                }
                councilResult = await runCouncil({
                  participants: councilPlan.participants,
                  prompt: b.text,
                  registry,
                  signal: controller.signal,
                  preferences,
                });
                emit({
                  type: "council",
                  ...councilUiSummary(councilResult, councilPlan),
                });
              }
              // Skipped council: do not emit a chat card (Activity log is enough).
            } catch {
              /* council failure is non-fatal for the main reply */
            }
            timing.mark("council_done");
          } else {
            councilPlan = {
              enabled: false,
              triggerReason: "fast_path",
              participants: [],
            };
            timing.mark("council_start");
            timing.mark("council_done");
          }
          timing.mark("context_done");
          timing.mark("prepare_start");
          if (routing.provider === "ollama" || !routing.provider) {
            const prep = await ollama.prepare?.(routing.model, controller.signal, {
              soft: useFastPath || routing.jeddawiQuality,
            });
            if (prep?.alreadyLoaded) timing.setFlag("model_already_loaded", true);
          }
          timing.mark("model_ready");
          const priorEventId = latestEventId(
            store
              .events(user.id)
              .filter((e) => e.chat_id === boundChat.id),
          );
          await runAgent({
            store,
            ollama,
            providerRegistry: registry,
            tools,
            chatId: boundChat.id,
            text: b.text,
            attachments: b.attachments,
            model: routing.model,
            profile: routing.profile,
            capabilities: routing.capabilities,
            gaming,
            signal: controller.signal,
            emit,
            requestedMode: modeInfo.requestedMode,
            memoryProposals,
            userId: user.id,
            user,
            turnPolicy: turn,
            timing,
            councilContext: useFastPath
              ? turn.directive || ""
              : [
                  councilResult?.synthesis || "",
                  turn.directive || "",
                  selfRepairDiagnosis
                    ? formatProposalForPrompt(selfRepairDiagnosis)
                    : "",
                  selfRepairProposal
                    ? formatProposalForPrompt(selfRepairProposal)
                    : "",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
            provider: routing.provider || "ollama",
            fallbackModels: useFastPath ? [] : routing.fallbackModels || [],
          });
          timing.mark("generation_done");
          {
            const snap = timing.snapshot({
              model: routing.model,
              kind: routing.kind,
              requestedModel: routing.requestedModel,
              fastPath: useFastPath,
            });
            selfRepair.recordLastTurn(snap);
            // Always emit timing so live/ops can measure first_token / guard / renderer.
            if (devTimingEnabled()) timing.log("turn", snap);
            emit({ type: "timing", ...snap });
          }

          // Automatic bounded Council evidence Round 2 (tool evidence only).
          let evidencePack = null;
          let evidenceRound = null;
          if (!useFastPath) try {
            // TURN-SCOPED: only events created during this agent turn.
            const turnEvents = eventsForCurrentTurn(
              store.events(user.id),
              { chatId: boundChat.id, afterId: priorEventId },
            );
            evidencePack = buildEvidencePack(turnEvents, {
              taskType: routing.kind || modeInfo.effectiveMode || "general",
              chatId: boundChat.id,
            });
            const reviewDecision = shouldRunEvidenceRound({
              pack: evidencePack,
              gaming,
              round1Result: councilResult,
              participants: councilPlan?.participants || [],
              preferences:
                turn.allowVerification === false
                  ? { ...preferences, councilMode: "off" }
                  : preferences,
            });
            if (reviewDecision.run && turn.allowVerification !== false) {
              evidenceRound = await runCouncilEvidenceRound({
                priorRound: 1,
                participants: councilPlan.participants,
                prompt: b.text,
                evidence: formatEvidencePack(evidencePack),
                registry,
                signal: controller.signal,
                preferences,
              });
              evidenceRound.evidenceRound = true;
              evidenceRound.evidenceTypes = evidenceTypesFromPack(evidencePack);
              evidenceRound.testsVerified = evidencePack.tests?.passed === true;
              evidenceRound.verification = evidencePack.tests
                ? evidencePack.tests.passed
                  ? "tests_passed"
                  : "tests_failed"
                : evidencePack.research?.sources?.length
                  ? "sources_present"
                  : "evidence_reviewed";
              emit({
                type: "council",
                ...councilUiSummary(evidenceRound, councilPlan),
              });
            } else if (
              councilResult &&
              !councilResult.skipped &&
              evidencePack?.meaningful &&
              turn.allowVerification !== false
            ) {
              // Do not emit skipped evidence cards into the chat UI.
            }

            if (
              shouldAttachVerification({
                intent: turn,
                text: b.text,
                evidencePack,
                explicitVerify: turn.explicitVerify,
                allowVerification: turn.allowVerification,
                turnScoped: true,
              })
            ) {
              const grounded = synthesizeFromEvidence({
                pack: evidencePack,
                round2Result: evidenceRound,
                taskText: b.text,
              });
              if (
                grounded &&
                !/^No decisive verification evidence/i.test(grounded)
              ) {
                const note = `\n\n---\nVerification\n${grounded}`;
                store.message(boundChat.id, "assistant", note);
                emit({ type: "token", text: note });
              }
            }
          } catch {
            /* evidence review is best-effort */
          }

          // Persist a verified coding lesson only when tests actually passed.
          try {
            if (evidencePack?.tests?.passed) {
              persistVerifiedLesson(
                store,
                lessonFromCodingSuccess({
                  summary: `Verified fix approach for: ${b.text.slice(0, 120)}`,
                  testEvidence: `run_tests exit ${evidencePack.tests.exitCode} pass`,
                  userId: user.id,
                  chatId: boundChat.id,
                  project: tools.workspace,
                }),
              );
              registry.recordQuality?.(
                routing.provider || "ollama",
                routing.model,
                2,
              );
            }
          } catch {
            /* lesson persistence is best-effort */
          }
          }
        } catch (e) {
          emit({
            type: "error",
            error: controller.signal.aborted ? "تم إيقاف المهمة." : e.message,
          });
        } finally {
          tools.workspace = previousToolsWorkspace;
          tools.setArtifactContext(null);
          active = null;
          finish();
          res.end();
        }
        return;
      }
      if (
        route === "/api/artifacts/cleanup" &&
        req.method === "POST"
      ) {
        const b = await body(req);
        const result = await cleanupArtifacts(store, artifacts, {
          actorUserId: user.id,
          workspaceId:
            typeof b.workspaceId === "string" ? b.workspaceId : null,
          olderThanMs:
            typeof b.olderThanMs === "number" ? b.olderThanMs : null,
          names: Array.isArray(b.names) ? b.names : null,
        });
        return json(res, 200, result);
      }
      if (req.method !== "GET") return json(res, 404, { error: "Not found" });
      if (route === "/" && (isLocal || nativeRemote)) {
        const shell = sessionIdentity(req);
        if (!shell?.user) {
          res.writeHead(302, {
            Location: "/login",
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }
      }
      let filename;
      if (
        route.startsWith("/artifacts/") &&
        /^[a-z]+-\d+\.png$/i.test(path.basename(route))
      ) {
        // Resolve ownership server-side; never trust client path/workspace IDs.
        const artifactIdentity = sessionIdentity(req);
        if (!artifactIdentity?.user)
          return json(res, 403, { error: "Invalid session token" });
        try {
          const authorized = await authorizeArtifactRead(store, artifacts, {
            name: path.basename(route),
            userId: artifactIdentity.user.id,
          });
          filename = authorized.absolute;
        } catch (error) {
          return json(res, error.status || 404, {
            error: error.message || "Not found",
          });
        }
      } else if (
        [
          "/",
          "/login",
          "/signup",
          "/forgot",
          "/reset",
          "/verify",
          "/auth.js",
          "/app.js",
          "/branding.js",
          "/i18n.js",
          "/dropdown.js",
          "/chat-visibility.js",
          "/jack/icon.png",
          "/jack/logo.png",
          "/jack/avatar.png",
          "/style.css",
          "/polish.css",
          "/favicon.svg",
          "/vendor/marked.esm.js",
          "/vendor/purify.es.mjs",
        ].includes(route)
      )
        filename = path.join(
          root,
          "public",
          route === "/"
            ? "index.html"
            : ["/login", "/signup", "/forgot", "/reset", "/verify"].includes(route)
              ? "auth.html"
              : route.slice(1),
        );
      else return json(res, 404, { error: "Not found" });
      const content = await fs.readFile(filename);
      const mime = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      res.writeHead(200, {
        "Content-Type": mime[path.extname(filename)],
        "Cache-Control": "no-cache",
      });
      res.end(content);
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: e.message });
      else res.end();
    }
  });
  return {
    server,
    store,
    token,
    root,
    ollama,
    registry,
    memoryProposals,
    selfRepair,
    artifactsDirectory: artifacts,
    cleanupArtifacts: (opts) => cleanupArtifacts(store, artifacts, opts),
    close: async () => {
      clearInterval(timer);
      if (active) {
        const run = active;
        run.controller.abort();
        await run.finished;
      }
      await tools.close();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  loadLocalEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const app = await createApp();
  const port = Number(process.env.COFFEEJACK_PORT ?? 3210);
  app.server.listen(port, "127.0.0.1", () =>
    console.log(`CoffeeJack ready: http://127.0.0.1:${port}`),
  );
  app.server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  for (const event of ["SIGINT", "SIGTERM"])
    process.on(event, async () => {
      await app.close();
      process.exit(0);
    });
}
