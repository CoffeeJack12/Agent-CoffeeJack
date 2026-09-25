/**
 * CoffeeJack-native accounts — Standard signup, sessions, isolation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import {
  createSession,
  getSession,
  resolveLocalOwner,
  revokeSession,
} from "../server/users.mjs";
import { MAIL_UNCONFIGURED_MESSAGE } from "../server/email.mjs";
import {
  RESET_TTL_MS,
  VERIFY_TTL_MS,
  MAX_CODE_ATTEMPTS,
} from "../server/auth-codes.mjs";
import {
  authorize,
  canSelfRepair,
  publicAccountNeedsVerification,
} from "../server/permissions.mjs";
import { looksLikePasswordHash, passwordHashPresent } from "../server/accounts.mjs";
import { personaDeterministicReply } from "../server/conversation-style.mjs";
import { LUBNA_SPEAKER } from "../server/speaker-persona.mjs";
import { applySpeakerPersonaClaim } from "../server/speaker-persona.mjs";

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

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-acct-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

async function appFixture(t) {
  process.env.COFFEEJACK_AUTH_DEV = "1";
  const dir = await tempDir(t);
  const app = await createApp({
    dataDirectory: dir,
    root: dir,
    remoteAccess: null,
    ollama: fakeOllama,
  });
  app.store.set("autoGaming", false);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections?.();
    await app.close();
    delete process.env.COFFEEJACK_AUTH_DEV;
  });
  return {
    app,
    dir,
    base: `http://127.0.0.1:${app.server.address().port}`,
  };
}

function sessionCookie(res) {
  const lines =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") || ""];
  for (const line of lines) {
    const match = /coffeejack_session=([^;]+)/.exec(line || "");
    if (match) return decodeURIComponent(match[1]);
  }
  return "";
}

function cookieHeader(res) {
  const lines =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") || ""];
  return lines.join("\n");
}

async function request(base, route, { method = "GET", body, session, header = false, cookie = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (session && header) headers["X-CoffeeJack-Token"] = session;
  if (session && cookie)
    headers.Cookie = `coffeejack_session=${encodeURIComponent(session)}`;
  const res = await fetch(base + route, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  const setCookie = cookieHeader(res);
  return {
    status: res.status,
    data,
    cookie: sessionCookie(res),
    httpOnly: /HttpOnly/i.test(setCookie),
    setCookie,
  };
}

function post(base, route, body, session, opts) {
  return request(base, route, {
    method: "POST",
    body: body || {},
    session,
    ...opts,
  });
}

function get(base, route, session, opts) {
  return request(base, route, { method: "GET", session, ...opts });
}

const strong = "CorrectHorse9";

function assertNoSessionToken(data) {
  assert.equal(data.token, undefined);
  assert.equal("token" in data, false);
}

test("registration creates Standard only and ignores client role", async (t) => {
  const { app, base } = await appFixture(t);
  const ownerId = resolveLocalOwner(app.store).id;
  const r = await post(base, "/api/auth/register", {
    displayName: "Lina",
    email: "lina@example.com",
    password: strong,
    confirmPassword: strong,
    role: "owner",
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, "standard");
  assert.equal(r.data.user.email_verified, false);
  assertNoSessionToken(r.data);
  assert.equal(resolveLocalOwner(app.store).id, ownerId);
  const owners = app.store.db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role='owner'")
    .get();
  assert.equal(owners.n, 1);
});

test("duplicate email blocked; password stored as scrypt hash", async (t) => {
  const { app, base } = await appFixture(t);
  const body = {
    displayName: "Ada",
    email: "ada@example.com",
    password: strong,
    confirmPassword: strong,
  };
  assert.equal((await post(base, "/api/auth/register", body)).status, 201);
  const dup = await post(base, "/api/auth/register", body);
  assert.equal(dup.status, 400);
  const row = app.store.db
    .prepare("SELECT password_hash,email FROM users WHERE email_normalized=?")
    .get("ada@example.com");
  assert.equal(row.email, "ada@example.com");
  assert.equal(looksLikePasswordHash(row.password_hash), true);
  assert.doesNotMatch(row.password_hash, /CorrectHorse/);
  assert.equal(passwordHashPresent(app.store, resolveLocalOwner(app.store).id), false);
});

test("public login JSON has no session token; HttpOnly cookie auth works", async (t) => {
  const { app, base } = await appFixture(t);
  await post(base, "/api/auth/register", {
    displayName: "Bea",
    email: "bea@example.com",
    password: strong,
    confirmPassword: strong,
  });
  const bad = await post(base, "/api/auth/login", {
    email: "bea@example.com",
    password: "WrongPass99",
  });
  assert.equal(bad.status, 401);
  const first = await post(base, "/api/auth/login", {
    email: "bea@example.com",
    password: strong,
  });
  assert.equal(first.status, 200);
  assertNoSessionToken(first.data);
  assert.equal(first.data.user.role, "standard");
  assert.ok(first.cookie);
  assert.equal(first.httpOnly, true);
  assert.match(first.setCookie, /HttpOnly/i);
  assert.ok(getSession(app.store, first.cookie));
  const me = await get(base, "/api/auth/me", first.cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, "bea@example.com");
  const second = await post(
    base,
    "/api/auth/login",
    { email: "bea@example.com", password: strong },
    first.cookie,
    { header: false, cookie: true },
  );
  assert.equal(second.status, 200);
  assertNoSessionToken(second.data);
  assert.notEqual(second.cookie, first.cookie);
  assert.equal(getSession(app.store, first.cookie), undefined);
  assert.ok(getSession(app.store, second.cookie));
  const out = await post(base, "/api/auth/logout", {}, second.cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(out.status, 200);
  assert.equal(getSession(app.store, second.cookie), undefined);
});

test("unauthenticated API denied; Standard cannot use Owner tools", async (t) => {
  const { app, base } = await appFixture(t);
  const denied = await get(base, "/api/chats");
  assert.equal(denied.status, 403);
  await post(base, "/api/auth/register", {
    displayName: "Cara",
    email: "cara@example.com",
    password: strong,
    confirmPassword: strong,
  });
  const login = await post(base, "/api/auth/login", {
    email: "cara@example.com",
    password: strong,
  });
  const user = login.data.user;
  assert.equal(authorize({ user, capability: "system_inspect" }).decision, "deny");
  assert.equal(authorize({ user, capability: "terminal_safe" }).decision, "deny");
  assert.equal(authorize({ user, capability: "user_management" }).decision, "deny");
  assert.equal(authorize({ user, capability: "self_repair" }).decision, "deny");
  assert.equal(canSelfRepair(user), false);
  const apply = await post(
    base,
    "/api/self-repair/x",
    { action: "apply" },
    login.cookie,
    { header: false, cookie: true },
  );
  assert.equal(apply.status, 403);
});

test("Standard cannot read another user's chats, memory, or artifacts", async (t) => {
  const { app, base } = await appFixture(t);
  const regA = await post(base, "/api/auth/register", {
    displayName: "UserA",
    email: "a@example.com",
    password: strong,
    confirmPassword: strong,
  });
  const regB = await post(base, "/api/auth/register", {
    displayName: "UserB",
    email: "b@example.com",
    password: strong,
    confirmPassword: strong,
  });
  assert.equal(
    (
      await post(
        base,
        "/api/auth/verify",
        { code: regA.data.devToken },
        regA.cookie,
        { header: false, cookie: true },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await post(
        base,
        "/api/auth/verify",
        { code: regB.data.devToken },
        regB.cookie,
        { header: false, cookie: true },
      )
    ).status,
    200,
  );
  const a = await post(base, "/api/auth/login", {
    email: "a@example.com",
    password: strong,
  });
  const b = await post(base, "/api/auth/login", {
    email: "b@example.com",
    password: strong,
  });
  const created = app.store.createChat("secret-a", a.data.user.id);
  const steal = await get(base, `/api/chats/${created.id}`, b.cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(steal.status, 404);
  app.store.remember("A private note", "note", null, { userId: a.data.user.id });
  const mem = await get(base, "/api/memories", b.cookie, {
    header: false,
    cookie: true,
  });
  const blob = JSON.stringify(mem.data);
  assert.doesNotMatch(blob, /A private note/);
});

test("I'm Abdulrahman / I'm Lubna do not change role", async (t) => {
  const { app, base } = await appFixture(t);
  const created = await post(base, "/api/auth/register", {
    displayName: "Sam",
    email: "sam@example.com",
    password: strong,
    confirmPassword: strong,
  });
  assert.equal(
    (
      await post(
        base,
        "/api/auth/verify",
        { code: created.data.devToken },
        created.cookie,
        { header: false, cookie: true },
      )
    ).status,
    200,
  );
  const login = await post(base, "/api/auth/login", {
    email: "sam@example.com",
    password: strong,
  });
  const abdulRes = await fetch(base + "/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `coffeejack_session=${encodeURIComponent(login.cookie)}`,
    },
    body: JSON.stringify({ text: "I'm Abdulrahman" }),
  });
  assert.equal(abdulRes.status, 200);
  const row = app.store.db
    .prepare("SELECT role FROM users WHERE id=?")
    .get(login.data.user.id);
  assert.equal(row.role, "standard");
  assert.equal(
    applySpeakerPersonaClaim(null, "I'm Lubna", login.data.user).honorific,
    "Queen",
  );
  assert.equal(
    personaDeterministicReply({ language: "en" }, login.data.user, "call_me", LUBNA_SPEAKER),
    "Queen.",
  );
  assert.equal(row.role, "standard");
});

test("unverified Standard cannot use chat, models, research, or files until verified", async (t) => {
  process.env.COFFEEJACK_AUTH_DEV = "1";
  const dir = await tempDir(t);
  let generations = 0;
  const app = await createApp({
    dataDirectory: dir,
    root: dir,
    remoteAccess: null,
    ollama: {
      models: async () => [{ name: "qwen3:8b" }],
      inspect: async () => ({ capabilities: ["tools"] }),
      prepare: async () => ({ alreadyLoaded: true, unloaded: [] }),
      unload: async () => [],
      chat: async ({ onToken }) => {
        generations += 1;
        onToken("ok");
        return { role: "assistant", content: "ok", tokens: 1 };
      },
    },
  });
  app.store.set("autoGaming", false);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections?.();
    await app.close();
    delete process.env.COFFEEJACK_AUTH_DEV;
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const created = await post(base, "/api/auth/register", {
    displayName: "Una",
    email: "una@example.com",
    password: strong,
    confirmPassword: strong,
  });
  const login = await post(base, "/api/auth/login", {
    email: "una@example.com",
    password: strong,
  });
  const cookie = login.cookie;
  const unverified = login.data.user;
  assert.equal(unverified.email_verified, false);
  assert.equal(publicAccountNeedsVerification(unverified), true);
  assert.equal(authorize({ user: unverified, capability: "chat" }).decision, "deny");
  assert.equal(authorize({ user: unverified, capability: "research" }).decision, "deny");
  assert.equal(authorize({ user: unverified, capability: "files_read" }).decision, "deny");

  const status = await get(base, "/api/status", cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(status.status, 200);
  assert.equal(status.data.user.email_verification_required, true);

  const chat = await post(base, "/api/chat", { text: "hello there" }, cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(chat.status, 403);
  assert.equal(chat.data.code, "email_unverified");
  assert.equal(generations, 0);

  const research = await post(
    base,
    "/api/chat",
    { text: "search the latest Ollama release" },
    cookie,
    { header: false, cookie: true },
  );
  assert.equal(research.status, 403);
  assert.equal(generations, 0);

  const upload = await post(
    base,
    "/api/upload",
    { name: "note.txt", data: Buffer.from("x").toString("base64") },
    cookie,
    { header: false, cookie: true },
  );
  assert.equal(upload.status, 403);
  const files = await get(base, "/api/memories", cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(files.status, 403);

  const resent = await post(base, "/api/auth/resend", {}, cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(resent.status, 200);
  const verify = await post(
    base,
    "/api/auth/verify",
    { code: resent.data.devToken || created.data.devToken },
    cookie,
    { header: false, cookie: true },
  );
  assert.equal(verify.status, 200);
  assert.equal(verify.data.user.email_verified, true);

  const verifiedUser = {
    ...unverified,
    email_verified: true,
  };
  assert.equal(publicAccountNeedsVerification(verifiedUser), false);
  assert.equal(authorize({ user: verifiedUser, capability: "chat" }).decision, "allow");
  assert.equal(authorize({ user: verifiedUser, capability: "research" }).decision, "allow");
  assert.equal(authorize({ user: verifiedUser, capability: "files_read" }).decision, "allow");
  assert.equal(authorize({ user: verifiedUser, capability: "system_inspect" }).decision, "deny");

  const afterStatus = await get(base, "/api/status", cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(afterStatus.data.user.email_verified, true);
  assert.equal(afterStatus.data.user.email_verification_required, false);

  const allowed = await post(base, "/api/chat", { text: "hello there" }, cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(allowed.status, 200);
  assert.ok(generations >= 1);

  const ownerChat = await post(
    base,
    "/api/chat",
    { text: "owner health check" },
    app.token,
    { header: true, cookie: false },
  );
  assert.equal(ownerChat.status, 200);
  const owner = resolveLocalOwner(app.store);
  assert.equal(owner.role, "owner");
  assert.equal(publicAccountNeedsVerification(owner), false);
  assert.equal(authorize({ user: owner, capability: "chat" }).decision, "allow");
});

test("verification code is 6 digits, hashed, single-use, and attempt-limited", async (t) => {
  const { app, base } = await appFixture(t);
  const created = await post(base, "/api/auth/register", {
    displayName: "Eve",
    email: "eve@example.com",
    password: strong,
    confirmPassword: strong,
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.email_verified, false);
  assert.match(created.data.devToken, /^\d{6}$/);
  assertNoSessionToken(created.data);
  const stored = app.store.db
    .prepare(
      "SELECT token_hash,attempts,expires_at,created FROM auth_tokens WHERE purpose='verify' AND used_at IS NULL",
    )
    .get();
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.token_hash, created.data.devToken);
  assert.doesNotMatch(stored.token_hash, /^\d{6}$/);
  const ttl = Date.parse(stored.expires_at) - Date.parse(stored.created);
  assert.ok(Math.abs(ttl - VERIFY_TTL_MS) < 2000);

  const wrong = await post(
    base,
    "/api/auth/verify",
    { code: created.data.devToken === "000000" ? "000001" : "000000" },
    created.cookie,
    { header: false, cookie: true },
  );
  assert.equal(wrong.status, 400);
  const afterWrong = app.store.db
    .prepare("SELECT attempts FROM auth_tokens WHERE token_hash=?")
    .get(stored.token_hash);
  assert.equal(afterWrong.attempts, 1);

  const first = await post(
    base,
    "/api/auth/verify",
    { code: created.data.devToken },
    created.cookie,
    { header: false, cookie: true },
  );
  assert.equal(first.status, 200);
  assert.equal(first.data.user.email_verified, true);
  const again = await post(
    base,
    "/api/auth/verify",
    { code: created.data.devToken },
    created.cookie,
    { header: false, cookie: true },
  );
  assert.equal(again.status, 400);
});

test("five failed codes lock; resend invalidates; expired codes fail", async (t) => {
  const { app, base } = await appFixture(t);
  const created = await post(base, "/api/auth/register", {
    displayName: "Ivy",
    email: "ivy@example.com",
    password: strong,
    confirmPassword: strong,
  });
  const good = created.data.devToken;
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
    const fail = await post(
      base,
      "/api/auth/verify",
      { code: "111111" === good ? "222222" : "111111" },
      created.cookie,
      { header: false, cookie: true },
    );
    assert.equal(fail.status, 400);
  }
  const locked = await post(
    base,
    "/api/auth/verify",
    { code: good },
    created.cookie,
    { header: false, cookie: true },
  );
  assert.equal(locked.status, 400);
  assert.match(locked.data.error, /Too many incorrect attempts/);

  const resent = await post(base, "/api/auth/resend", {}, created.cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(resent.status, 200);
  assert.match(resent.data.devToken, /^\d{6}$/);
  assert.notEqual(resent.data.devToken, good);
  const stale = await post(
    base,
    "/api/auth/verify",
    { code: good },
    created.cookie,
    { header: false, cookie: true },
  );
  assert.equal(stale.status, 400);
  const ok = await post(
    base,
    "/api/auth/verify",
    { code: resent.data.devToken },
    created.cookie,
    { header: false, cookie: true },
  );
  assert.equal(ok.status, 200);

  const later = await post(base, "/api/auth/register", {
    displayName: "Old",
    email: "old@example.com",
    password: strong,
    confirmPassword: strong,
  });
  app.store.db
    .prepare("UPDATE auth_tokens SET expires_at=? WHERE user_id=? AND purpose='verify'")
    .run(new Date(Date.now() - 1000).toISOString(), later.data.user.id);
  const expired = await post(
    base,
    "/api/auth/verify",
    { code: later.data.devToken },
    later.cookie,
    { header: false, cookie: true },
  );
  assert.equal(expired.status, 400);
});

test("password reset is neutral, 30-minute, single-use, and revokes sessions", async (t) => {
  const { app, base } = await appFixture(t);
  const created = await post(base, "/api/auth/register", {
    displayName: "Dee",
    email: "dee@example.com",
    password: strong,
    confirmPassword: strong,
  });
  await post(
    base,
    "/api/auth/verify",
    { code: created.data.devToken },
    created.cookie,
    { header: false, cookie: true },
  );
  const login = await post(base, "/api/auth/login", {
    email: "dee@example.com",
    password: strong,
  });
  const missing = await post(base, "/api/auth/forgot", {
    email: "nobody@example.com",
  });
  const exists = await post(base, "/api/auth/forgot", {
    email: "dee@example.com",
  });
  assert.equal(missing.status, 200);
  assert.equal(exists.status, 200);
  assert.equal(missing.data.message, exists.data.message);
  assert.ok(!missing.data.devToken);
  assert.match(exists.data.devToken, /^\d{6}$/);
  const againForgot = await post(base, "/api/auth/forgot", {
    email: "dee@example.com",
  });
  assert.match(againForgot.data.devToken, /^\d{6}$/);
  assert.notEqual(againForgot.data.devToken, exists.data.devToken);
  const resetRow = app.store.db
    .prepare(
      "SELECT expires_at,created,token_hash FROM auth_tokens WHERE purpose='reset' AND used_at IS NULL",
    )
    .get();
  const ttl = Date.parse(resetRow.expires_at) - Date.parse(resetRow.created);
  assert.ok(Math.abs(ttl - RESET_TTL_MS) < 2000);
  assert.notEqual(resetRow.token_hash, againForgot.data.devToken);
  const oldReset = await post(base, "/api/auth/reset", {
    email: "dee@example.com",
    code: exists.data.devToken,
    password: "NewPassword9",
    confirmPassword: "NewPassword9",
  });
  assert.equal(oldReset.status, 400);

  const reset = await post(base, "/api/auth/reset", {
    email: "dee@example.com",
    code: againForgot.data.devToken,
    password: "NewPassword9",
    confirmPassword: "NewPassword9",
  });
  assert.equal(reset.status, 200);
  assert.equal(getSession(app.store, login.cookie), undefined);
  const me = await get(base, "/api/auth/me", login.cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(me.status, 401);
  const again = await post(base, "/api/auth/reset", {
    email: "dee@example.com",
    code: exists.data.devToken,
    password: "NewerPass99",
    confirmPassword: "NewerPass99",
  });
  assert.equal(again.status, 400);
  const stale = await post(base, "/api/auth/reset", {
    email: "dee@example.com",
    code: "000000",
    password: "AnotherPass9",
    confirmPassword: "AnotherPass9",
  });
  assert.equal(stale.status, 400);
});

test("auth rate limits trip; Owner data survives signup", async (t) => {
  const { app, base } = await appFixture(t);
  const owner = resolveLocalOwner(app.store);
  app.store.remember("Owner memory stays", "note", null, { userId: owner.id });
  for (let i = 0; i < 9; i++) {
    await post(base, "/api/auth/login", {
      email: "nope@example.com",
      password: "WrongPass99",
    });
  }
  const limited = await post(base, "/api/auth/login", {
    email: "nope@example.com",
    password: "WrongPass99",
  });
  assert.equal(limited.status, 429);
  assert.equal(resolveLocalOwner(app.store).id, owner.id);
  const notes = JSON.stringify(app.store.memories("Owner", owner.id));
  assert.match(notes, /Owner memory stays/);
});

test("Owner can attach credentials without a second Owner", async (t) => {
  const { app, base } = await appFixture(t);
  const owner = resolveLocalOwner(app.store);
  const session = createSession(app.store, owner.id, { source: "local" });
  const set = await post(
    base,
    "/api/auth/owner/credentials",
    {
      email: "abdul@example.com",
      password: strong,
      confirmPassword: strong,
    },
    session.token,
    { header: true, cookie: false },
  );
  assert.equal(set.status, 200);
  assert.equal(set.data.user.role, "owner");
  assert.equal(set.data.user.email_verified, true);
  const owners = app.store.db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role='owner'")
    .get();
  assert.equal(owners.n, 1);
  const login = await post(base, "/api/auth/login", {
    email: "abdul@example.com",
    password: strong,
  });
  assert.equal(login.status, 200);
  assertNoSessionToken(login.data);
  assert.equal(login.data.user.role, "owner");
  assert.equal(login.data.user.id, owner.id);
});

test("signup creates HttpOnly cookie; /verify uses 6-digit code; same account upgrades", async (t) => {
  const sent = [];
  const dir = await tempDir(t);
  const app = await createApp({
    dataDirectory: dir,
    root: process.cwd(),
    remoteAccess: null,
    ollama: fakeOllama,
    mailSender: async (message) => {
      sent.push(message);
    },
  });
  app.store.set("autoGaming", false);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections?.();
    await app.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const registerRes = await fetch(base + "/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      displayName: "Nia",
      email: "nia@example.com",
      password: strong,
      confirmPassword: strong,
    }),
  });
  const created = await registerRes.json();
  const cookie = sessionCookie(registerRes);
  assert.equal(registerRes.status, 201);
  assert.equal(created.user.role, "standard");
  assert.equal(created.user.email_verified, false);
  assertNoSessionToken(created);
  assert.ok(cookie);
  assert.ok(getSession(app.store, cookie));
  assert.match(registerRes.headers.get("set-cookie") || "", /HttpOnly/i);
  const verifyPage = await fetch(base + "/verify");
  assert.equal(verifyPage.status, 200);
  const html = await verifyPage.text();
  assert.match(html, /رمز تأكيد البريد/);
  assert.match(html, /maxlength="6"/);
  assert.doesNotMatch(html, /Invalid session token/);
  const me = await get(base, "/api/auth/me", cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, created.user.id);
  assert.equal(me.data.user.email_verified, false);
  assert.equal(me.data.user.email_verification_required, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /CoffeeJack/);
  assert.match(sent[0].html, /CoffeeJack/);
  assert.match(sent[0].text, /Verification code:/);
  assert.doesNotMatch(sent[0].text, /\?code=/);
  const code = sent[0].text.match(/Verification code:\n(\d{6})/)?.[1];
  assert.match(code, /^\d{6}$/);
  const audits = JSON.stringify(
    app.store.db.prepare("SELECT action,detail FROM audit_events").all(),
  );
  assert.doesNotMatch(audits, new RegExp(code));
  const resent = await post(base, "/api/auth/resend", {}, cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(resent.status, 200);
  assert.equal(sent.length, 2);
  const newCode = sent[1].text.match(/Verification code:\n(\d{6})/)?.[1];
  const verified = await post(
    base,
    "/api/auth/verify",
    { code: newCode },
    cookie,
    { header: false, cookie: true },
  );
  assert.equal(verified.status, 200);
  assert.equal(verified.data.user.id, created.user.id);
  assert.equal(verified.data.user.email_verified, true);
  assert.ok(getSession(app.store, cookie));
  const after = await get(base, "/api/auth/me", cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(after.data.user.email_verified, true);
  assert.equal(after.data.user.email_verification_required, false);
});

test("missing SMTP is honest; expired session asks to log in again", async (t) => {
  const dir = await tempDir(t);
  const app = await createApp({
    dataDirectory: dir,
    root: dir,
    remoteAccess: null,
    ollama: fakeOllama,
  });
  app.store.set("autoGaming", false);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections?.();
    await app.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const config = await get(base, "/api/auth/config");
  assert.equal(config.data.mail.configured, false);
  assert.equal(config.data.mail.message, MAIL_UNCONFIGURED_MESSAGE);
  const created = await post(base, "/api/auth/register", {
    displayName: "Ora",
    email: "ora@example.com",
    password: strong,
    confirmPassword: strong,
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.mail.configured, false);
  assert.equal(created.data.mail.message, MAIL_UNCONFIGURED_MESSAGE);
  assert.equal(created.data.mail.delivered, false);
  assert.ok(!created.data.devToken);
  assertNoSessionToken(created.data);
  const expired = await get(base, "/api/auth/me", "not-a-real-session", {
    header: false,
    cookie: true,
  });
  assert.equal(expired.status, 401);
  assert.equal(expired.data.code, "session_expired");
  assert.equal(expired.data.error, "Your session expired. Please log in again.");
  revokeSession(app.store, created.cookie);
  const afterRevoke = await post(base, "/api/auth/resend", {}, created.cookie, {
    header: false,
    cookie: true,
  });
  assert.equal(afterRevoke.status, 401);
  assert.equal(afterRevoke.data.error, "Your session expired. Please log in again.");
});
