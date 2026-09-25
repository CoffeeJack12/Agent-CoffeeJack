import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { getAuthUser } from "../server/auth.mjs";
import { createMailer } from "../server/mail.mjs";
import { createSession, resolveLocalOwner } from "../server/users.mjs";

const fakeOllama = {
  models: async () => [{ name: "test" }],
  inspect: async () => ({ capabilities: ["tools"] }),
  prepare: async () => {},
  unload: async () => [],
  chat: async ({ onToken }) => {
    onToken("done");
    return { role: "assistant", content: "done", tokens: 1 };
  },
};

function recordingMailer(mode = "smtp") {
  const sent = [];
  return {
    mode,
    sent,
    async send(message) {
      sent.push(message);
      return { delivered: true, mode, id: String(sent.length) };
    },
  };
}

async function runningApp(t, { mailer } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coffeejack-auth-"));
  const app = await createApp({ dataDirectory: dir, ollama: fakeOllama, mailer });
  app.store.set("autoGaming", false);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.server.closeAllConnections?.();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

function readSessionCookie(res) {
  const cookies = res.headers.getSetCookie?.() || [];
  for (const cookie of cookies) {
    const match = /^coffeejack_session=([^;]+)/.exec(cookie);
    if (match) return `coffeejack_session=${match[1]}`;
  }
  return null;
}

async function call(base, route, { method = "GET", body, cookie } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      Connection: "close",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, ok: res.ok, data, res };
}

function codeFrom(message) {
  return message ? (/\b(\d{6})\b/.exec(message.text) || [])[1] : undefined;
}

async function signup(base, mailer, email = "user@example.com", password = "hunter2pass") {
  const res = await fetch(base + "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  return {
    status: res.status,
    data,
    cookie: readSessionCookie(res),
    code: mailer?.sent?.length ? codeFrom(mailer.sent[mailer.sent.length - 1]) : undefined,
  };
}

// 1
test("signup creates an unverified standard user", async (t) => {
  const mailer = recordingMailer();
  const { app, base } = await runningApp(t, { mailer });
  const { status, data } = await signup(base, mailer);
  assert.equal(status, 201);
  assert.equal(data.user.role, "standard");
  assert.equal(data.user.verified, false);
  const row = getAuthUser(app.store, data.user.id);
  assert.equal(row.role, "standard");
  assert.equal(row.email_verified, 0);
  assert.equal(row.email, "user@example.com");
});

// 2
test("signup establishes a valid authenticated session (cookie)", async (t) => {
  const mailer = recordingMailer();
  const { base } = await runningApp(t, { mailer });
  const { cookie } = await signup(base, mailer);
  assert.ok(cookie, "a session cookie is set on signup");
  const session = await call(base, "/api/auth/session", { cookie });
  assert.equal(session.status, 200);
  assert.equal(session.data.authenticated, true);
});

// 3
test("signup redirects to /verify and that same session is recognized there", async (t) => {
  const mailer = recordingMailer();
  const { base } = await runningApp(t, { mailer });
  const { data, cookie } = await signup(base, mailer);
  assert.equal(data.redirect, "/verify");
  const session = await call(base, "/api/auth/session", { cookie });
  assert.equal(session.data.authenticated, true);
  assert.equal(session.data.user.email, "user@example.com");
  const page = await fetch(base + "/verify");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") || "", /text\/html/);
});

// 4
test("/verify recognizes the unverified session", async (t) => {
  const mailer = recordingMailer();
  const { base } = await runningApp(t, { mailer });
  const { cookie } = await signup(base, mailer);
  const session = await call(base, "/api/auth/session", { cookie });
  assert.equal(session.data.user.verified, false);
});

// 5
test("successful verification upgrades the same account", async (t) => {
  const mailer = recordingMailer();
  const { app, base } = await runningApp(t, { mailer });
  const { cookie, code, data } = await signup(base, mailer);
  assert.match(code, /^\d{6}$/);
  const verify = await call(base, "/api/auth/verify", {
    method: "POST",
    body: { code },
    cookie,
  });
  assert.equal(verify.status, 200);
  assert.equal(verify.data.redirect, "/");
  const session = await call(base, "/api/auth/session", { cookie });
  assert.equal(session.data.user.verified, true);
  assert.equal(session.data.user.id, data.user.id);
  assert.equal(getAuthUser(app.store, data.user.id).email_verified, 1);
});

// 6
test("expired or invalid session yields a clean session-expired signal", async (t) => {
  const mailer = recordingMailer();
  const { app, base } = await runningApp(t, { mailer });

  const anon = await call(base, "/api/auth/session");
  assert.equal(anon.status, 401);
  assert.equal(anon.data.code, "session_expired");
  assert.match(anon.data.error, /session expired/i);
  assert.doesNotMatch(anon.data.error, /Invalid session token/i);

  const owner = resolveLocalOwner(app.store);
  const expired = createSession(app.store, owner.id, { ttlMs: -1000 });
  const cookie = `coffeejack_session=${expired.token}`;
  const stale = await call(base, "/api/auth/session", { cookie });
  assert.equal(stale.status, 401);
  assert.equal(stale.data.code, "session_expired");

  const verify = await call(base, "/api/auth/verify", {
    method: "POST",
    body: { code: "123456" },
    cookie,
  });
  assert.equal(verify.status, 401);
  assert.equal(verify.data.code, "session_expired");
});

// 7
test("missing SMTP returns an honest 'email not configured' state", async (t) => {
  const mailer = createMailer({ env: {} });
  const { base } = await runningApp(t, { mailer });
  const config = await call(base, "/api/auth/config");
  assert.equal(config.data.mode, "unconfigured");
  assert.equal(config.data.emailConfigured, false);
  const { data } = await signup(base, mailer, "nomail@example.com");
  assert.equal(data.email.configured, false);
  assert.equal(data.email.delivered, false);
});

// 8
test("a configured provider sends a branded verification message", async (t) => {
  const mailer = recordingMailer("smtp");
  const { base } = await runningApp(t, { mailer });
  const config = await call(base, "/api/auth/config");
  assert.equal(config.data.mode, "smtp");
  const { data } = await signup(base, mailer, "sendme@example.com");
  assert.equal(data.email.delivered, true);
  assert.equal(mailer.sent.length, 1);
  const message = mailer.sent[0];
  assert.equal(message.to, "sendme@example.com");
  assert.match(message.subject, /verify/i);
  assert.match(message.text, /CoffeeJack/);
  assert.match(message.text, /\b\d{6}\b/);
  assert.match(message.text, /expire/i);
  assert.match(message.text, /ignore/i);
});

// 9
test("resend verification issues a new working code and supersedes the old one", async (t) => {
  const mailer = recordingMailer("smtp");
  const { base } = await runningApp(t, { mailer });
  const { cookie } = await signup(base, mailer, "resend@example.com");
  const oldCode = codeFrom(mailer.sent[0]);
  const resend = await call(base, "/api/auth/resend", {
    method: "POST",
    body: {},
    cookie,
  });
  assert.equal(resend.status, 200);
  assert.equal(mailer.sent.length, 2);
  const newCode = codeFrom(mailer.sent[1]);
  if (oldCode !== newCode) {
    const superseded = await call(base, "/api/auth/verify", {
      method: "POST",
      body: { code: oldCode },
      cookie,
    });
    assert.equal(superseded.status, 400);
  }
  const good = await call(base, "/api/auth/verify", {
    method: "POST",
    body: { code: newCode },
    cookie,
  });
  assert.equal(good.status, 200);
});

// 10
test("no plaintext verification code is written to logs", async (t) => {
  const logs = [];
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
  for (const key of Object.keys(original))
    console[key] = (...args) => {
      logs.push(args.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
    };
  t.after(() => Object.assign(console, original));

  const mailer = recordingMailer("smtp");
  const { app, base } = await runningApp(t, { mailer });
  const { cookie, code, data } = await signup(base, mailer, "logs@example.com");
  await call(base, "/api/auth/verify", { method: "POST", body: { code }, cookie });
  Object.assign(console, original);

  const blob = logs.join("\n");
  assert.ok(code && !blob.includes(code), "verification code must not appear in logs");
  const auditRows = app.store.db
    .prepare("SELECT detail FROM audit_events WHERE user_id=?")
    .all(data.user.id);
  for (const row of auditRows)
    assert.ok(!row.detail.includes(code), "verification code must not appear in audit detail");
});

test("duplicate email signup is rejected", async (t) => {
  const mailer = recordingMailer();
  const { base } = await runningApp(t, { mailer });
  const first = await signup(base, mailer, "dupe@example.com");
  assert.equal(first.status, 201);
  const second = await signup(base, mailer, "dupe@example.com");
  assert.equal(second.status, 400);
  assert.match(second.data.error, /already registered/i);
});

test("login authenticates and routes unverified users to /verify", async (t) => {
  const mailer = recordingMailer("smtp");
  const { base } = await runningApp(t, { mailer });
  await signup(base, mailer, "login@example.com", "secretpass1");
  const bad = await call(base, "/api/auth/login", {
    method: "POST",
    body: { email: "login@example.com", password: "wrongpass" },
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.code, "invalid_credentials");
  const good = await call(base, "/api/auth/login", {
    method: "POST",
    body: { email: "login@example.com", password: "secretpass1" },
  });
  assert.equal(good.status, 200);
  assert.equal(good.data.redirect, "/verify");
});

test("password reset uses the same provider and updates the password", async (t) => {
  const mailer = recordingMailer("smtp");
  const { base } = await runningApp(t, { mailer });
  await signup(base, mailer, "reset@example.com", "originalpass1");
  const request = await call(base, "/api/auth/reset/request", {
    method: "POST",
    body: { email: "reset@example.com" },
  });
  assert.equal(request.status, 200);
  const resetMessage = mailer.sent[mailer.sent.length - 1];
  assert.match(resetMessage.subject, /reset/i);
  const code = codeFrom(resetMessage);
  const confirm = await call(base, "/api/auth/reset/confirm", {
    method: "POST",
    body: { email: "reset@example.com", code, password: "brandnewpass1" },
  });
  assert.equal(confirm.status, 200);
  const login = await call(base, "/api/auth/login", {
    method: "POST",
    body: { email: "reset@example.com", password: "brandnewpass1" },
  });
  assert.equal(login.status, 200);
});
