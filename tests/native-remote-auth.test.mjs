import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.mjs";
import { createNativeRemoteAccess } from "../server/access.mjs";
import { attachOwnerCredentials } from "../server/accounts.mjs";
import {
  authorize,
  publicAccountNeedsVerification,
} from "../server/permissions.mjs";
import { getSession, resolveLocalOwner } from "../server/users.mjs";
import {
  registerArtifact,
  ensureScopedArtifactDir,
  artifactRelativePath,
} from "../server/artifacts.mjs";
import {
  ensureUserWorkspace,
  listWorkspacesForUser,
} from "../server/workspaces.mjs";

const HOST = "coffeejack-agent.com";
const ORIGIN = "https://coffeejack-agent.com";
const strong = "CorrectHorse9";
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const fakeOllama = {
  models: async () => [{ name: "qwen3:8b" }],
  inspect: async () => ({ capabilities: ["tools"] }),
  prepare: async () => ({ alreadyLoaded: true, unloaded: [] }),
  unload: async () => [],
  chat: async ({ onToken }) => {
    onToken("ok");
    return { role: "assistant", content: "ok", tokens: 1 };
  },
};

function cookieFrom(headers) {
  const raw = headers["set-cookie"];
  const lines = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const line = lines.find((item) => /coffeejack_session=/.test(item || "")) || "";
  const match = /coffeejack_session=([^;]+)/.exec(line);
  return {
    token: match ? decodeURIComponent(match[1]) : "",
    header: line,
    httpOnly: /HttpOnly/i.test(line),
    secure: /;\s*Secure/i.test(line),
    sameSiteLax: /SameSite=Lax/i.test(line),
  };
}

function httpReq(port, route, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload =
      opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers = {
      Host: opts.host ?? HOST,
      Origin: opts.origin === undefined ? ORIGIN : opts.origin,
      "Content-Type": "application/json",
      Connection: "close",
      ...(opts.cookie
        ? { Cookie: `coffeejack_session=${encodeURIComponent(opts.cookie)}` }
        : {}),
      ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      ...opts.headers,
    };
    if (opts.origin === null) delete headers.Origin;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method: opts.method || "GET",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            data = { raw: text };
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data,
            cookie: cookieFrom(res.headers),
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function nativeApp(t, { ollama = fakeOllama } = {}) {
  process.env.COFFEEJACK_AUTH_DEV = "1";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-native-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    delete process.env.COFFEEJACK_AUTH_DEV;
  });
  const app = await createApp({
    dataDirectory: dir,
    root: REPO_ROOT,
    remoteAccess: createNativeRemoteAccess(HOST),
    ollama,
  });
  app.store.set("autoGaming", false);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections?.();
    await app.close();
  });
  return { app, dir, port: app.server.address().port };
}

function assertNoToken(data) {
  assert.equal(data.token, undefined);
  assert.equal("token" in data, false);
  assert.doesNotMatch(JSON.stringify(data), /coffeejack_session=/i);
}

async function register(port, overrides = {}) {
  return httpReq(port, "/api/auth/register", {
    method: "POST",
    body: {
      displayName: "Pat",
      email: "pat@example.com",
      password: strong,
      confirmPassword: strong,
      role: "owner",
      ...overrides,
    },
  });
}

test("public register works without CF JWT and stays Standard", async (t) => {
  const { port, app } = await nativeApp(t);
  const res = await register(port, { role: "trusted" });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.role, "standard");
  assertNoToken(res.data);
  assert.equal(res.cookie.httpOnly, true);
  assert.equal(res.cookie.secure, true);
  assert.equal(res.cookie.sameSiteLax, true);
  assert.ok(getSession(app.store, res.cookie.token));
  const ownerCount = app.store.db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role='owner'")
    .get().n;
  assert.equal(ownerCount, 1);
});

test("login works with HttpOnly Secure cookie and JSON has no token", async (t) => {
  const { port } = await nativeApp(t);
  await register(port, { email: "login@example.com", displayName: "Lee" });
  const res = await httpReq(port, "/api/auth/login", {
    method: "POST",
    body: { email: "login@example.com", password: strong },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.email, "login@example.com");
  assertNoToken(res.data);
  assert.equal(res.cookie.httpOnly, true);
  assert.equal(res.cookie.secure, true);
  assert.equal(res.cookie.sameSiteLax, true);
  assert.match(res.cookie.token, /\S+/);
});

test("/api/status without session is denied remotely and does not bootstrap Owner", async (t) => {
  const { port, app } = await nativeApp(t);
  const before = app.store.db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked IS NULL")
    .get().n;
  const res = await httpReq(port, "/api/status");
  assert.equal(res.status, 401);
  assert.match(res.data.code, /authentication_required|session_expired/);
  assert.equal(res.data.user, undefined);
  const after = app.store.db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked IS NULL")
    .get().n;
  assert.equal(after, before);
});

test("valid native session can access its own status", async (t) => {
  const { port } = await nativeApp(t);
  const created = await register(port, { email: "me@example.com" });
  const res = await httpReq(port, "/api/status", { cookie: created.cookie.token });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.email, "me@example.com");
  assert.equal(res.data.user.role, "standard");
  assert.equal(res.data.user.email_verification_required, true);
});

test("unverified remote user cannot use chat or tools", async (t) => {
  let generations = 0;
  const { port } = await nativeApp(t, {
    ollama: {
      ...fakeOllama,
      chat: async ({ onToken }) => {
        generations += 1;
        onToken("ok");
        return { role: "assistant", content: "ok", tokens: 1 };
      },
    },
  });
  const created = await register(port, { email: "wait@example.com" });
  const chat = await httpReq(port, "/api/chat", {
    method: "POST",
    cookie: created.cookie.token,
    body: { text: "hello there" },
  });
  assert.equal(chat.status, 403);
  assert.equal(chat.data.code, "email_unverified");
  assert.equal(generations, 0);
});

test("verified Standard remains restricted", async (t) => {
  const { port } = await nativeApp(t);
  const created = await register(port, { email: "std@example.com" });
  const verified = await httpReq(port, "/api/auth/verify", {
    method: "POST",
    cookie: created.cookie.token,
    body: { code: created.data.devToken },
  });
  assert.equal(verified.status, 200);
  const user = verified.data.user;
  assert.equal(publicAccountNeedsVerification(user), false);
  assert.equal(authorize({ user, capability: "chat" }).decision, "allow");
  assert.equal(authorize({ user, capability: "system_inspect" }).decision, "deny");
  assert.equal(authorize({ user, capability: "terminal_safe" }).decision, "deny");
  assert.equal(authorize({ user, capability: "user_management" }).decision, "deny");
  assert.equal(authorize({ user, capability: "self_repair" }).decision, "deny");
  const users = await httpReq(port, "/api/users", { cookie: created.cookie.token });
  assert.equal(users.status, 200);
  assert.equal(users.data.length, 1);
  const repair = await httpReq(port, "/api/self-repair/x", {
    method: "POST",
    cookie: created.cookie.token,
    body: { action: "apply" },
  });
  assert.equal(repair.status, 403);
});

test("users cannot access one another's chats, memory, or files", async (t) => {
  const { port, app, dir } = await nativeApp(t);
  const a = await register(port, { email: "a@example.com", displayName: "A" });
  const b = await register(port, { email: "b@example.com", displayName: "B" });
  for (const who of [a, b]) {
    assert.equal(
      (
        await httpReq(port, "/api/auth/verify", {
          method: "POST",
          cookie: who.cookie.token,
          body: { code: who.data.devToken },
        })
      ).status,
      200,
    );
  }
  const chat = app.store.createChat("secret-a", a.data.user.id);
  const steal = await httpReq(port, `/api/chats/${chat.id}`, {
    cookie: b.cookie.token,
  });
  assert.equal(steal.status, 404);
  app.store.remember("A private note", "note", null, { userId: a.data.user.id });
  const mem = await httpReq(port, "/api/memories", { cookie: b.cookie.token });
  assert.doesNotMatch(JSON.stringify(mem.data), /A private note/);
  await ensureUserWorkspace(app.store, a.data.user.id, dir);
  const wsA = listWorkspacesForUser(app.store, a.data.user.id)[0];
  const name = "secreta-1.png";
  const scoped = await ensureScopedArtifactDir(
    app.artifactsDirectory,
    a.data.user.id,
    wsA.id,
  );
  await fs.writeFile(path.join(scoped, name), Buffer.from("private-file"));
  registerArtifact(app.store, {
    name,
    userId: a.data.user.id,
    workspaceId: wsA.id,
    relativePath: artifactRelativePath(a.data.user.id, wsA.id, name),
  });
  const file = await httpReq(port, `/artifacts/${name}`, {
    cookie: b.cookie.token,
  });
  assert.equal(file.status, 403);
});

test("spoofed Cloudflare headers give no privilege", async (t) => {
  const { port, app } = await nativeApp(t);
  const owner = resolveLocalOwner(app.store);
  const res = await httpReq(port, "/api/status", {
    headers: {
      "Cf-Ray": "1",
      "Cf-Access-Authenticated-User-Email": "owner@example.com",
      "Cf-Access-Jwt-Assertion": "not.a.jwt",
      "Cf-Access-Authenticated-User-Id": owner.id,
    },
  });
  assert.equal(res.status, 401);
  assert.equal(res.data.user, undefined);
  const sessions = app.store.db
    .prepare(
      "SELECT user_id FROM sessions WHERE revoked IS NULL AND source='remote'",
    )
    .all();
  assert.equal(sessions.length, 0);
});

test("wrong Host is rejected", async (t) => {
  const { port } = await nativeApp(t);
  const res = await httpReq(port, "/api/auth/config", {
    host: "evil.example",
    origin: "https://evil.example",
  });
  assert.equal(res.status, 403);
  assert.match(res.data.error, /Invalid host|Remote authentication/i);
});

test("cross-origin API request is rejected", async (t) => {
  const { port } = await nativeApp(t);
  const res = await httpReq(port, "/api/auth/login", {
    method: "POST",
    origin: "https://evil.example",
    body: { email: "x@example.com", password: strong },
  });
  assert.equal(res.status, 403);
  assert.equal(res.data.error, "Cross-origin request denied");
});

test("public hostname never bootstraps Owner; Owner logs in with own credentials", async (t) => {
  const { port, app } = await nativeApp(t);
  const signup = await register(port, { email: "public@example.com", role: "owner" });
  assert.equal(signup.data.user.role, "standard");
  const owner = resolveLocalOwner(app.store);
  await attachOwnerCredentials(app.store, owner, {
    email: "abdul@example.com",
    password: strong,
    confirmPassword: strong,
  });
  const login = await httpReq(port, "/api/auth/login", {
    method: "POST",
    body: { email: "abdul@example.com", password: strong },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, "owner");
  assertNoToken(login.data);
  const status = await httpReq(port, "/api/status", {
    cookie: login.cookie.token,
  });
  assert.equal(status.status, 200);
  assert.equal(status.data.user.role, "owner");
  assert.equal(status.data.user.id, owner.id);
});

test("remote profile switching remains denied", async (t) => {
  const { port, app } = await nativeApp(t);
  const created = await register(port, { email: "sw@example.com" });
  await httpReq(port, "/api/auth/verify", {
    method: "POST",
    cookie: created.cookie.token,
    body: { code: created.data.devToken },
  });
  const owner = resolveLocalOwner(app.store);
  const denied = await httpReq(port, "/api/session/switch", {
    method: "POST",
    cookie: created.cookie.token,
    body: { userId: owner.id },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, "remote_switch_denied");
});

test("verify and resend require a CoffeeJack session", async (t) => {
  const { port } = await nativeApp(t);
  const verify = await httpReq(port, "/api/auth/verify", {
    method: "POST",
    body: { code: "123456" },
  });
  assert.equal(verify.status, 401);
  assert.equal(verify.data.code, "session_expired");
  const resend = await httpReq(port, "/api/auth/resend", { method: "POST" });
  assert.equal(resend.status, 401);
  assert.equal(resend.data.code, "session_expired");
});

test("tunnel-marked loopback never bootstraps Owner in native mode", async (t) => {
  const { port, app } = await nativeApp(t);
  const res = await httpReq(port, "/api/status", {
    host: "127.0.0.1",
    origin: null,
    headers: {
      "Cf-Ray": "tunnel",
      "Cf-Connecting-IP": "9.9.9.9",
      "Cf-Access-Authenticated-User-Email": "owner@example.com",
    },
  });
  assert.equal(res.status, 401);
  assert.equal(res.data.code, "authentication_required");
  assert.equal(res.data.user, undefined);
  const remoteSessions = app.store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE revoked IS NULL AND source='remote'",
    )
    .get().n;
  assert.equal(remoteSessions, 0);
});

test("publicBase uses configured host, not a tunnel loopback Host header", async (t) => {
  const { port, dir } = await nativeApp(t);
  const res = await httpReq(port, "/api/auth/register", {
    method: "POST",
    host: "127.0.0.1",
    origin: null,
    headers: {
      "Cf-Ray": "tunnel",
      "Cf-Connecting-IP": "9.9.9.9",
    },
    body: {
      displayName: "Tun",
      email: "tun@example.com",
      password: strong,
      confirmPassword: strong,
    },
  });
  assert.equal(res.status, 201);
  const mailbox = JSON.parse(
    await fs.readFile(path.join(dir, "auth-dev-mailbox.json"), "utf8"),
  );
  const latest = mailbox.at(-1);
  assert.match(latest.text, /https:\/\/coffeejack-agent\.com\/verify/);
  assert.doesNotMatch(latest.text, /127\.0\.0\.1/);
});

test("local Owner bootstrap still works on direct loopback", async (t) => {
  const { port, app } = await nativeApp(t);
  const res = await httpReq(port, "/api/status", {
    host: "127.0.0.1",
    origin: "http://127.0.0.1",
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.role, "owner");
  assert.equal(res.data.user.id, resolveLocalOwner(app.store).id);
});

test("protected API routes require a native session", async (t) => {
  const { port } = await nativeApp(t);
  const chats = await httpReq(port, "/api/chats");
  assert.equal(chats.status, 403);
  assert.equal(chats.data.error, "Invalid session token");
});

test("auth config reports native mode and public host", async (t) => {
  const { port } = await nativeApp(t);
  const res = await httpReq(port, "/api/auth/config");
  assert.equal(res.status, 200);
  assert.equal(res.data.remoteAuth, "native");
  assert.equal(res.data.publicHost, HOST);
  assert.equal(res.data.publicRegistration, true);
});

test("native remote GET / without session redirects to /login and does not bootstrap Owner", async (t) => {
  const { port, app } = await nativeApp(t);
  const before = app.store.db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked IS NULL")
    .get().n;
  const res = await httpReq(port, "/", { origin: null });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/login");
  assert.doesNotMatch(res.data.raw || "", /id="messages"|Invalid session token/i);
  const after = app.store.db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked IS NULL")
    .get().n;
  assert.equal(after, before);
  const remoteSessions = app.store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE revoked IS NULL AND source='remote'",
    )
    .get().n;
  assert.equal(remoteSessions, 0);
});

test("native remote GET / with a valid session serves the app", async (t) => {
  const { port } = await nativeApp(t);
  const created = await register(port, { email: "shell@example.com" });
  const res = await httpReq(port, "/", { cookie: created.cookie.token });
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"] || ""), /text\/html/);
  assert.match(res.data.raw || "", /id="messages"|CoffeeJack/i);
});

test("public auth pages and static assets remain reachable without a session", async (t) => {
  const { port } = await nativeApp(t);
  for (const route of ["/login", "/signup", "/forgot", "/reset", "/verify"]) {
    const page = await httpReq(port, route, { origin: null });
    assert.equal(page.status, 200, route);
    assert.match(String(page.headers["content-type"] || ""), /text\/html/);
    assert.match(page.data.raw || "", /id="authForm"/);
  }
  for (const route of ["/auth.js", "/branding.js", "/style.css", "/favicon.svg"]) {
    const asset = await httpReq(port, route, { origin: null });
    assert.equal(asset.status, 200, route);
  }
});

test("direct localhost GET / still serves the app shell", async (t) => {
  const { port } = await nativeApp(t);
  const res = await httpReq(port, "/", {
    host: "127.0.0.1",
    origin: "http://127.0.0.1",
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"] || ""), /text\/html/);
  assert.notEqual(res.headers.location, "/login");
  assert.match(res.data.raw || "", /id="messages"|CoffeeJack/i);
});

test("app.js never emits an undefined CoffeeJack token header", async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, "public/app.js"), "utf8");
  assert.match(src, /function sessionHeaders/);
  assert.doesNotMatch(src, /["']X-CoffeeJack-Token["']\s*:\s*state\.token/);
  assert.doesNotMatch(src, /X-CoffeeJack-Token["']\s*:\s*undefined/);
  assert.match(src, /location\.replace\(\s*["']\/login["']\s*\)/);
});

test("forgot and reset are reachable remotely without a session", async (t) => {
  const { port } = await nativeApp(t);
  await register(port, { email: "reset@example.com" });
  const forgot = await httpReq(port, "/api/auth/forgot", {
    method: "POST",
    body: { email: "reset@example.com" },
  });
  assert.equal(forgot.status, 200);
  assert.match(forgot.data.devToken || "", /^\d{6}$/);
  const reset = await httpReq(port, "/api/auth/reset", {
    method: "POST",
    body: {
      email: "reset@example.com",
      code: forgot.data.devToken,
      password: "CorrectHorse8",
      confirmPassword: "CorrectHorse8",
    },
  });
  assert.equal(reset.status, 200);
});
