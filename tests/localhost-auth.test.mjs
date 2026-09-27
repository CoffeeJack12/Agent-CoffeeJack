/**
 * Localhost browser sessions require CoffeeJack authentication.
 * Loopback must not bootstrap or attach an Owner session.
 */
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
import { getSession, resolveLocalOwner } from "../server/users.mjs";

const PUBLIC_HOST = "coffeejack-agent.com";
const PUBLIC_ORIGIN = "https://coffeejack-agent.com";
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
    cleared: /Max-Age=0/i.test(line),
  };
}

function liveSessions(app) {
  return app.store.db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked IS NULL")
    .get().n;
}

function httpReq(port, route, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload =
      opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const host = opts.host ?? "127.0.0.1";
    const headers = {
      Host: host,
      Origin:
        opts.origin === undefined
          ? host === PUBLIC_HOST
            ? PUBLIC_ORIGIN
            : `http://${host}`
          : opts.origin,
      "Content-Type": "application/json",
      Connection: "close",
      ...(opts.cookie
        ? { Cookie: `coffeejack_session=${encodeURIComponent(opts.cookie)}` }
        : {}),
      ...(opts.token ? { "X-CoffeeJack-Token": opts.token } : {}),
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

async function startApp(t, { remoteAccess = null } = {}) {
  process.env.COFFEEJACK_AUTH_DEV = "1";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-localhost-auth-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    delete process.env.COFFEEJACK_AUTH_DEV;
  });
  const app = await createApp({
    dataDirectory: dir,
    root: REPO_ROOT,
    remoteAccess,
    ollama: fakeOllama,
  });
  app.store.set("autoGaming", false);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections?.();
    await app.close();
  });
  return { app, dir, port: app.server.address().port };
}

function localOnlyApp(t) {
  return startApp(t);
}

function nativeApp(t) {
  return startApp(t, { remoteAccess: createNativeRemoteAccess(PUBLIC_HOST) });
}

async function loginLocal(port, { email, password, host = "127.0.0.1" }) {
  return httpReq(port, "/api/auth/login", {
    host,
    method: "POST",
    body: { email, password },
  });
}

async function attachOwner(app, email = "abdulrahman@local.test") {
  const owner = resolveLocalOwner(app.store);
  await attachOwnerCredentials(app.store, owner, {
    email,
    password: strong,
    confirmPassword: strong,
  });
  return owner;
}

async function registerLocal(port, overrides = {}, host = "127.0.0.1") {
  return httpReq(port, "/api/auth/register", {
    host,
    method: "POST",
    body: {
      displayName: "Pat",
      email: "pat@example.com",
      password: strong,
      confirmPassword: strong,
      ...overrides,
    },
  });
}

test("unauthenticated localhost GET / redirects to /login", async (t) => {
  const { port } = await localOnlyApp(t);
  for (const host of ["127.0.0.1", "localhost"]) {
    const res = await httpReq(port, "/", { host, origin: `http://${host}` });
    assert.equal(res.status, 302, host);
    assert.equal(res.headers.location, "/login", host);
    assert.equal(res.cookie.token, "");
    assert.doesNotMatch(res.data.raw || "", /id="messages"/i);
  }
});

test("localhost /api/status without session returns 401", async (t) => {
  const { port } = await localOnlyApp(t);
  for (const host of ["127.0.0.1", "localhost"]) {
    const res = await httpReq(port, "/api/status", { host });
    assert.equal(res.status, 401, host);
    assert.equal(res.data.code, "authentication_required", host);
    assert.equal(res.data.user, undefined, host);
    assert.equal(res.cookie.token, "");
  }
});

test("localhost does not create an Owner session", async (t) => {
  const { port, app } = await localOnlyApp(t);
  const owner = resolveLocalOwner(app.store);
  const before = liveSessions(app);
  assert.ok(before >= 1, "process handle session may exist");
  const status = await httpReq(port, "/api/status", { host: "127.0.0.1" });
  const page = await httpReq(port, "/", { host: "localhost" });
  const named = await httpReq(port, "/api/status", {
    host: "localhost",
    headers: {
      "X-Forwarded-For": "127.0.0.1",
      "X-Real-IP": "127.0.0.1",
    },
  });
  assert.equal(status.status, 401);
  assert.equal(page.status, 302);
  assert.equal(named.status, 401);
  assert.equal(liveSessions(app), before);
  assert.equal(status.cookie.token, "");
  assert.equal(page.cookie.token, "");
  assert.equal(named.data.user, undefined);
  const ownerSessions = app.store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND revoked IS NULL AND source='account'",
    )
    .get(owner.id).n;
  assert.equal(ownerSessions, 0);
});

test("valid Owner login works locally", async (t) => {
  const { port, app } = await localOnlyApp(t);
  const owner = await attachOwner(app);
  const login = await loginLocal(port, {
    email: "abdulrahman@local.test",
    password: strong,
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.id, owner.id);
  assert.equal(login.data.user.role, "owner");
  assert.equal(login.data.token, undefined);
  assert.ok(login.cookie.token);
  assert.equal(login.cookie.httpOnly, true);
  assert.equal(login.cookie.secure, false);
  assert.ok(getSession(app.store, login.cookie.token));
  const status = await httpReq(port, "/api/status", {
    cookie: login.cookie.token,
  });
  assert.equal(status.status, 200);
  assert.equal(status.data.user.id, owner.id);
  assert.equal(status.data.user.role, "owner");
  assert.equal(status.data.identitySource, "account");
  const page = await httpReq(port, "/", { cookie: login.cookie.token });
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"] || ""), /text\/html/);
});

test("Lubna login stays Lubna", async (t) => {
  const { port, app } = await localOnlyApp(t);
  const owner = resolveLocalOwner(app.store);
  const created = await registerLocal(port, {
    displayName: "Lubna",
    email: "lubna@example.com",
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.role, "standard");
  const login = await loginLocal(port, {
    email: "lubna@example.com",
    password: strong,
    host: "localhost",
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.display_name, "Lubna");
  assert.equal(login.data.user.role, "standard");
  assert.notEqual(login.data.user.id, owner.id);
  const status = await httpReq(port, "/api/status", {
    host: "localhost",
    cookie: login.cookie.token,
  });
  assert.equal(status.status, 200);
  assert.equal(status.data.user.id, login.data.user.id);
  assert.equal(status.data.user.display_name, "Lubna");
  assert.equal(status.data.user.role, "standard");
  assert.notEqual(status.data.user.role, "owner");
  assert.equal(status.data.identitySource, "account");
});

test("Standard remains Standard", async (t) => {
  const { port, app } = await localOnlyApp(t);
  const created = await registerLocal(port, {
    displayName: "Sam",
    email: "sam@example.com",
    role: "owner",
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.role, "standard");
  const login = await loginLocal(port, {
    email: "sam@example.com",
    password: strong,
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, "standard");
  const status = await httpReq(port, "/api/status", {
    cookie: login.cookie.token,
  });
  assert.equal(status.status, 200);
  assert.equal(status.data.user.role, "standard");
  assert.equal(status.data.user.id, created.data.user.id);
  const owners = app.store.db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role='owner'")
    .get().n;
  assert.equal(owners, 1);
});

test("logout invalidates the local session", async (t) => {
  const { port, app } = await localOnlyApp(t);
  await attachOwner(app);
  const login = await loginLocal(port, {
    email: "abdulrahman@local.test",
    password: strong,
  });
  assert.equal(login.status, 200);
  const token = login.cookie.token;
  const out = await httpReq(port, "/api/auth/logout", {
    method: "POST",
    cookie: token,
  });
  assert.equal(out.status, 200);
  assert.equal(out.data.ok, true);
  assert.equal(out.cookie.cleared, true);
  assert.equal(getSession(app.store, token), undefined);
  const status = await httpReq(port, "/api/status", { cookie: token });
  assert.equal(status.status, 401);
  assert.equal(status.data.code, "authentication_required");
  const page = await httpReq(port, "/", { cookie: token });
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, "/login");
});

test("refreshing a valid local session keeps the user logged in", async (t) => {
  const { port, app } = await localOnlyApp(t);
  const owner = await attachOwner(app);
  const login = await loginLocal(port, {
    email: "abdulrahman@local.test",
    password: strong,
  });
  const first = await httpReq(port, "/api/status", {
    cookie: login.cookie.token,
  });
  const second = await httpReq(port, "/api/status", {
    cookie: login.cookie.token,
  });
  const page = await httpReq(port, "/", { cookie: login.cookie.token });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.data.user.id, owner.id);
  assert.equal(second.data.user.role, "owner");
  assert.equal(page.status, 200);
  assert.ok(getSession(app.store, login.cookie.token));
});

test("Owner is not inferred from loopback, hostname, display name, or email", async (t) => {
  const { port, app } = await localOnlyApp(t);
  const owner = resolveLocalOwner(app.store);
  const created = await registerLocal(
    port,
    {
      displayName: "Abdulrahman",
      email: "owner@localhost.test",
    },
    "localhost",
  );
  assert.equal(created.status, 201);
  assert.equal(created.data.user.role, "standard");
  const login = await loginLocal(port, {
    email: "owner@localhost.test",
    password: strong,
    host: "localhost",
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.display_name, "Abdulrahman");
  assert.equal(login.data.user.role, "standard");
  assert.notEqual(login.data.user.id, owner.id);
  const status = await httpReq(port, "/api/status", {
    host: "127.0.0.1",
    cookie: login.cookie.token,
  });
  assert.equal(status.status, 200);
  assert.equal(status.data.user.id, created.data.user.id);
  assert.equal(status.data.user.role, "standard");
});

test("remote behavior remains unchanged", async (t) => {
  const { port, app } = await nativeApp(t);
  const before = liveSessions(app);
  const remotePage = await httpReq(port, "/", {
    host: PUBLIC_HOST,
    origin: null,
  });
  assert.equal(remotePage.status, 302);
  assert.equal(remotePage.headers.location, "/login");
  const remoteStatus = await httpReq(port, "/api/status", {
    host: PUBLIC_HOST,
  });
  assert.equal(remoteStatus.status, 401);
  assert.match(remoteStatus.data.code, /authentication_required|session_expired/);
  assert.equal(liveSessions(app), before);

  const owner = await attachOwner(app, "abdul@example.com");
  const remoteLogin = await httpReq(port, "/api/auth/login", {
    host: PUBLIC_HOST,
    method: "POST",
    body: { email: "abdul@example.com", password: strong },
  });
  assert.equal(remoteLogin.status, 200);
  assert.equal(remoteLogin.data.user.id, owner.id);
  assert.equal(remoteLogin.data.user.role, "owner");
  assert.equal(remoteLogin.cookie.secure, true);
  const remoteAuthed = await httpReq(port, "/api/status", {
    host: PUBLIC_HOST,
    cookie: remoteLogin.cookie.token,
  });
  assert.equal(remoteAuthed.status, 200);
  assert.equal(remoteAuthed.data.user.id, owner.id);

  const localAnon = await httpReq(port, "/api/status", { host: "127.0.0.1" });
  assert.equal(localAnon.status, 401);
  const localPage = await httpReq(port, "/", { host: "127.0.0.1" });
  assert.equal(localPage.status, 302);
  assert.equal(localPage.headers.location, "/login");
});
