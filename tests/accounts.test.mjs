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

async function post(base, route, body, token) {
  const res = await fetch(base + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-CoffeeJack-Token": token } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function get(base, route, token) {
  const res = await fetch(base + route, {
    headers: token ? { "X-CoffeeJack-Token": token } : {},
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const strong = "CorrectHorse9";

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

test("login success, bad password denied, session rotates, logout revokes", async (t) => {
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
  assert.ok(first.data.token);
  assert.equal(first.data.user.role, "standard");
  const second = await post(
    base,
    "/api/auth/login",
    { email: "bea@example.com", password: strong },
    first.data.token,
  );
  assert.equal(second.status, 200);
  assert.notEqual(second.data.token, first.data.token);
  assert.equal(getSession(app.store, first.data.token), undefined);
  assert.ok(getSession(app.store, second.data.token));
  const out = await post(base, "/api/auth/logout", {}, second.data.token);
  assert.equal(out.status, 200);
  assert.equal(getSession(app.store, second.data.token), undefined);
});

test("unauthenticated API denied; Standard cannot use Owner tools", async (t) => {
  const { app, base } = await appFixture(t);
  const denied = await get(base, "/api/chats");
  assert.equal(denied.status, 403);
  const reg = await post(base, "/api/auth/register", {
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
    login.data.token,
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
    (await post(base, "/api/auth/verify", { token: regA.data.devToken })).status,
    200,
  );
  assert.equal(
    (await post(base, "/api/auth/verify", { token: regB.data.devToken })).status,
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
  const steal = await get(base, `/api/chats/${created.id}`, b.data.token);
  assert.equal(steal.status, 404);
  app.store.remember("A private note", "note", null, { userId: a.data.user.id });
  const mem = await get(base, "/api/memories", b.data.token);
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
    (await post(base, "/api/auth/verify", { token: created.data.devToken })).status,
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
      "X-CoffeeJack-Token": login.data.token,
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
  const token = login.data.token;
  const unverified = login.data.user;
  assert.equal(unverified.email_verified, false);
  assert.equal(publicAccountNeedsVerification(unverified), true);
  assert.equal(authorize({ user: unverified, capability: "chat" }).decision, "deny");
  assert.equal(authorize({ user: unverified, capability: "research" }).decision, "deny");
  assert.equal(authorize({ user: unverified, capability: "files_read" }).decision, "deny");

  const status = await get(base, "/api/status", token);
  assert.equal(status.status, 200);
  assert.equal(status.data.user.email_verification_required, true);

  const chat = await post(base, "/api/chat", { text: "hello there" }, token);
  assert.equal(chat.status, 403);
  assert.equal(chat.data.code, "email_unverified");
  assert.equal(generations, 0);

  const research = await post(
    base,
    "/api/chat",
    { text: "search the latest Ollama release" },
    token,
  );
  assert.equal(research.status, 403);
  assert.equal(generations, 0);

  const upload = await post(
    base,
    "/api/upload",
    { name: "note.txt", data: Buffer.from("x").toString("base64") },
    token,
  );
  assert.equal(upload.status, 403);
  const files = await get(base, "/api/memories", token);
  assert.equal(files.status, 403);

  const resent = await post(base, "/api/auth/resend", {}, token);
  assert.equal(resent.status, 200);
  const verify = await post(base, "/api/auth/verify", {
    token: resent.data.devToken || created.data.devToken,
  });
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

  const afterStatus = await get(base, "/api/status", token);
  assert.equal(afterStatus.data.user.email_verified, true);
  assert.equal(afterStatus.data.user.email_verification_required, false);

  const allowed = await post(base, "/api/chat", { text: "hello there" }, token);
  assert.equal(allowed.status, 200);
  assert.ok(generations >= 1);

  const ownerChat = await post(
    base,
    "/api/chat",
    { text: "owner health check" },
    app.token,
  );
  assert.equal(ownerChat.status, 200);
  const owner = resolveLocalOwner(app.store);
  assert.equal(owner.role, "owner");
  assert.equal(publicAccountNeedsVerification(owner), false);
  assert.equal(authorize({ user: owner, capability: "chat" }).decision, "allow");
});

test("email verification token is single-use", async (t) => {
  const { app, base } = await appFixture(t);
  const created = await post(base, "/api/auth/register", {
    displayName: "Eve",
    email: "eve@example.com",
    password: strong,
    confirmPassword: strong,
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.email_verified, false);
  assert.ok(created.data.devToken);
  const first = await post(base, "/api/auth/verify", {
    token: created.data.devToken,
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.user.email_verified, true);
  const again = await post(base, "/api/auth/verify", {
    token: created.data.devToken,
  });
  assert.equal(again.status, 400);
});

test("password reset does not enumerate; token is single-use", async (t) => {
  const { app, base } = await appFixture(t);
  await post(base, "/api/auth/register", {
    displayName: "Dee",
    email: "dee@example.com",
    password: strong,
    confirmPassword: strong,
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
  assert.ok(exists.data.devToken);
  const token = exists.data.devToken;
  const reset = await post(base, "/api/auth/reset", {
    token,
    password: "NewPassword9",
    confirmPassword: "NewPassword9",
  });
  assert.equal(reset.status, 200);
  const again = await post(base, "/api/auth/reset", {
    token,
    password: "NewerPass99",
    confirmPassword: "NewerPass99",
  });
  assert.equal(again.status, 400);
  const expired = app.store.db
    .prepare("SELECT id FROM users WHERE email_normalized='dee@example.com'")
    .get();
  app.store.db
    .prepare(
      "INSERT INTO auth_tokens(id,user_id,purpose,token_hash,expires_at,used_at,created) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      "deadtoken",
      expired.id,
      "reset",
      "x".repeat(64),
      new Date(Date.now() - 1000).toISOString(),
      null,
      new Date().toISOString(),
    );
  const stale = await post(base, "/api/auth/reset", {
    token: "not-a-real-token-value-at-all",
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
  assert.equal(login.data.user.role, "owner");
  assert.equal(login.data.user.id, owner.id);
});

test("signup creates session; /verify recognizes it; verification upgrades same account", async (t) => {
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
  assert.equal(registerRes.status, 201);
  assert.equal(created.user.role, "standard");
  assert.equal(created.user.email_verified, false);
  assert.ok(created.token);
  assert.ok(getSession(app.store, created.token));
  assert.match(registerRes.headers.get("set-cookie") || "", /coffeejack_session=/);
  const verifyPage = await fetch(base + "/verify");
  assert.equal(verifyPage.status, 200);
  const html = await verifyPage.text();
  assert.match(html, /رمز تأكيد البريد/);
  assert.doesNotMatch(html, /Invalid session token/);
  const me = await get(base, "/api/auth/me", created.token);
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, created.user.id);
  assert.equal(me.data.user.email_verified, false);
  assert.equal(me.data.user.email_verification_required, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /CoffeeJack/);
  assert.match(sent[0].text, /Verification code:/);
  const code = sent[0].text.match(/Verification code:\n([^\n]+)/)?.[1];
  assert.ok(code);
  const audits = JSON.stringify(
    app.store.db.prepare("SELECT action,detail FROM audit_events").all(),
  );
  assert.doesNotMatch(audits, new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const resent = await post(base, "/api/auth/resend", {}, created.token);
  assert.equal(resent.status, 200);
  assert.equal(sent.length, 2);
  const newCode = sent[1].text.match(/Verification code:\n([^\n]+)/)?.[1];
  const verified = await post(base, "/api/auth/verify", { code: newCode }, created.token);
  assert.equal(verified.status, 200);
  assert.equal(verified.data.user.id, created.user.id);
  assert.equal(verified.data.user.email_verified, true);
  assert.ok(getSession(app.store, created.token));
  const after = await get(base, "/api/auth/me", created.token);
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
  assert.ok(created.data.token);
  const expired = await get(base, "/api/auth/me", "not-a-real-session");
  assert.equal(expired.status, 401);
  assert.equal(expired.data.code, "session_expired");
  assert.equal(expired.data.error, "Your session expired. Please log in again.");
  revokeSession(app.store, created.data.token);
  const afterRevoke = await post(base, "/api/auth/resend", {}, created.data.token);
  assert.equal(afterRevoke.status, 401);
  assert.equal(afterRevoke.data.error, "Your session expired. Please log in again.");
});

