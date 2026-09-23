import { getPreferences, savePreferences, LANGUAGES, ASSISTANT_LANGUAGES, APP_LANGUAGES, MODES, PACKS, PREFERENCE_OPTIONS, MEMORY_BEHAVIORS } from "./preferences.mjs";
import { resolveEffectiveMode } from "./auto-mode.mjs";
import { memoryCategory, createMemoryProposalStore } from "./auto-memory.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { accessFromEnvironment } from "./access.mjs";
import { classifyRequest, expectedOrigin } from "./trust.mjs";
import { createRateLimiter, REMOTE_RATE } from "./rate-limit.mjs";
import { Store } from "./store.mjs";
import { Ollama } from "./ollama.mjs";
import { Tools, runProcess } from "./tools.mjs";
import { routeModel } from "./router.mjs";
import { runAgent } from "./agent.mjs";
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
import { getPersona, validatePersona, selfModel } from "./personality.mjs";
import {
  applyLegacyOwnerAutoApprove,
  authorize,
  canManageUsers,
  canToggleGaming,
  permissionSummary,
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

export async function createApp({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  dataDirectory,
  ollama: providedOllama,
  remoteAccess,
} = {}) {
  const access = remoteAccess ?? accessFromEnvironment();
  const data = dataDirectory ?? path.join(root, ".local");
  const artifacts = path.join(data, "artifacts");
  await fs.mkdir(artifacts, { recursive: true });
  const store = new Store(data);
  ensureIdentitySchema(store);
  ensureWorkspaceSchema(store);
  const owner = resolveLocalOwner(store);
  await ensureOwnerWorkspace(store, { root, dataDirectory: data });
  const boot = createSession(store, owner.id, { source: "local" });
  let token = boot.token;
  const ollama = providedOllama ?? new Ollama(process.env.OLLAMA_URL);
  const registry = createDefaultRegistry(ollama);
  const approvals = new Map();
  const memoryProposals = createMemoryProposalStore(store);
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
        },
      });
      decision = applyLegacyOwnerAutoApprove(
        decision,
        user,
        store.get("autoApprove", false),
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
        approvals.set(id, { id, name, args, finish, userId: user.id });
        signal.addEventListener("abort", cancel, { once: true });
        active?.emit({ type: "approval", id, name, args });
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
  const setSessionCookie = (res, sessionToken, { remote }) => {
    if (!remote || !sessionToken) return;
    res.setHeader(
      "Set-Cookie",
      `coffeejack_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
    );
  };
  const clearSessionCookie = (res, { remote }) => {
    if (!remote) return;
    res.setHeader(
      "Set-Cookie",
      "coffeejack_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
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
    const host = req.headers.host ?? "";
    const trust = classifyRequest(req, {
      accessHostname: access?.hostname || null,
      accessConfigured: Boolean(access),
    });
    const isLocal = trust.mode === "local";
    let remoteIdentity = null;
    if (!isLocal) {
      if (!access)
        return json(res, 403, {
          error: "Remote authentication required",
          code: "access_not_configured",
        });
      const hostName = host.split(":")[0].toLowerCase();
      const accessHost = access.hostname.toLowerCase();
      // Public hostname must match; loopback+CF markers allowed only as tunnel rewrite.
      if (
        trust.reason !== "cloudflare_markers_on_loopback" &&
        hostName !== accessHost
      )
        return json(res, 403, { error: "Invalid host" });
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
    // Spoofed CF email headers never authorize — only verified JWT claims.
    const expected = expectedOrigin(req, {
      mode: trust.mode,
      accessHostname: access?.hostname,
    });
    if (
      (req.headers.origin && req.headers.origin !== expected) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return json(res, 403, { error: "Cross-origin request denied" });
    const url = new URL(req.url, `http://${host || "127.0.0.1"}`);
    const route = url.pathname;
    if (route.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    try {
      let identity = route.startsWith("/api/")
        ? sessionIdentity(req)
        : undefined;
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
          if (!isLocal) {
            return json(res, 403, { error: "Remote authentication required" });
          } else {
            const localSession = createSession(store, owner.id, {
              source: "local",
            });
            identity = {
              token: localSession.token,
              user: getUser(store, owner.id),
              session: getSession(store, localSession.token),
            };
          }
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
        } catch {
          /* keep ollama models */
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
          },
          identitySource: isLocal ? "local" : "cloudflare",
          identities: identities.map((i) => ({
            provider: i.provider,
            email: i.normalized_email,
            linked: true,
          })),
          permissions: permissionSummary(user),
          models,
          providers,
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
            .map(({ id, name, args }) => ({ id, name, args })),
        });
      }
      if (route.startsWith("/api/") && !identity)
        return json(res, 403, { error: "Invalid session token" });
      const user = identity?.user;
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
        if (!isLocal)
          return json(res, 403, {
            error: "Profile switching is local-only",
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
        clearSessionCookie(res, { remote: !isLocal });
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
        try {
          const preferences = {
            ...getPreferences(store, user.id),
            ...(user.role === "guest" ? { remoteAi: "never" } : {}),
          };
          const requestedMode =
            typeof b.requestedMode === "string" && b.requestedMode
              ? b.requestedMode
              : preferences.mode;
          const modeInfo = resolveEffectiveMode({
            requestedMode,
            text: b.text,
            attachments: b.attachments ?? [],
            history: store.messages(boundChat.id),
          });
          const requestedModel =
            typeof b.requestedModel === "string" && b.requestedModel
              ? b.requestedModel
              : preferences.model || "auto";
          const taskMode =
            b.mode && ["general", "coding", "vision"].includes(b.mode)
              ? b.mode
              : "auto";
          const routing = await routeModel({
            ollama,
            registry,
            settings: conf,
            text: b.text,
            mode: taskMode,
            attachments: b.attachments ?? [],
            history: store.messages(boundChat.id),
            signal: controller.signal,
            requestedModel,
            effectiveMode: modeInfo.effectiveMode,
            gaming,
            preferences,
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
          });
          // Provider-native Council (text proposals only; Jack sole tool executor).
          let councilResult = null;
          let councilPlan = null;
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
              text: b.text,
              preferences,
              gaming,
              effectiveMode: modeInfo.effectiveMode,
              taskKind: routing.kind,
              availableModels: available,
              lockedModel: locked,
              effectiveModel: routing.effectiveModel,
              healthLookup: (providerId, modelId) =>
                registry.getModelHealth(providerId, modelId),
            });
            if (!councilPlan.enabled) {
              emit({
                type: "council",
                ...councilUiSummary(
                  { skipped: true, reason: councilPlan.triggerReason },
                  councilPlan,
                ),
              });
            } else {
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
          } catch {
            emit({
              type: "council",
              ...councilUiSummary({ skipped: true, reason: "error" }),
            });
          }
          if (routing.provider === "ollama" || !routing.provider)
            await ollama.prepare?.(routing.model, controller.signal);
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
            councilContext: councilResult?.synthesis || "",
            provider: routing.provider || "ollama",
            fallbackModels: routing.fallbackModels || [],
          });

          // Automatic bounded Council evidence Round 2 (tool evidence only).
          let evidencePack = null;
          let evidenceRound = null;
          try {
            const turnEvents = store
              .events(user.id)
              .filter((e) => e.chat_id === boundChat.id);
            evidencePack = buildEvidencePack(turnEvents, {
              taskType: routing.kind || modeInfo.effectiveMode || "general",
              chatId: boundChat.id,
            });
            const reviewDecision = shouldRunEvidenceRound({
              pack: evidencePack,
              gaming,
              round1Result: councilResult,
              participants: councilPlan?.participants || [],
              preferences,
            });
            if (reviewDecision.run) {
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
              evidencePack?.meaningful
            ) {
              emit({
                type: "council",
                title: "Council Review",
                status: "skipped",
                detail: reviewDecision.reason,
                evidenceRound: true,
                evidenceTypes: evidenceTypesFromPack(evidencePack),
                testsVerified: evidencePack.tests?.passed === true,
              });
            }

            // Ground final note in verified evidence (wins over majority vote).
            if (evidencePack?.meaningful) {
              const grounded = synthesizeFromEvidence({
                pack: evidencePack,
                round2Result: evidenceRound,
                taskText: b.text,
              });
              if (grounded) {
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
        } catch (e) {
          emit({
            type: "error",
            error: controller.signal.aborted ? "تم إيقاف المهمة." : e.message,
          });
        } finally {
          tools.workspace = previousToolsWorkspace;
          active = null;
          finish();
          res.end();
        }
        return;
      }
      if (req.method !== "GET") return json(res, 404, { error: "Not found" });
      let filename;
      if (
        route.startsWith("/artifacts/") &&
        /^[a-z]+-\d+\.png$/.test(path.basename(route))
      )
        filename = path.join(artifacts, path.basename(route));
      else if (
        [
          "/",
          "/app.js",
          "/branding.js",
          "/i18n.js",
          "/dropdown.js",
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
          route === "/" ? "index.html" : route.slice(1),
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
    ollama,
    registry,
    memoryProposals,
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
