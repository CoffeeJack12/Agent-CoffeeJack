import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { Store } from "../server/store.mjs";
import {
  ensureAuthSchema,
  signup,
  issueCode,
  verifyPassword,
} from "../server/auth.mjs";
import { resolveMailMode, createMailer, MAIL_MODES } from "../server/mail.mjs";

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

async function tempStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coffeejack-authsec-"));
  const store = new Store(dir);
  ensureAuthSchema(store);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return store;
}

async function runningApp(t, { mailer } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coffeejack-authsec-http-"));
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

test("passwords are stored as scrypt hashes, never plaintext", async (t) => {
  const store = await tempStore(t);
  const user = signup(store, { email: "pw@example.com", password: "correcthorse" });
  const row = store.db.prepare("SELECT password_hash FROM users WHERE id=?").get(user.id);
  assert.ok(row.password_hash.startsWith("scrypt$"));
  assert.ok(!row.password_hash.includes("correcthorse"));
  assert.equal(verifyPassword(row.password_hash, "correcthorse"), true);
  assert.equal(verifyPassword(row.password_hash, "wrong"), false);
});

test("verification codes are stored hashed, not in cleartext", async (t) => {
  const store = await tempStore(t);
  const user = signup(store, { email: "code@example.com", password: "correcthorse" });
  const { code } = issueCode(store, user.id, "verify");
  const row = store.db
    .prepare(
      "SELECT code_hash FROM auth_codes WHERE user_id=? AND consumed IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get(user.id);
  assert.ok(row.code_hash && row.code_hash !== code);
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
});

test("session cookie is HttpOnly and not placed in any URL", async (t) => {
  const mailer = recordingMailer();
  const { base } = await runningApp(t, { mailer });
  const res = await fetch(base + "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ email: "cookie@example.com", password: "correcthorse" }),
  });
  const setCookies = res.headers.getSetCookie?.() || [];
  const sessionCookie = setCookies.find((c) => c.startsWith("coffeejack_session="));
  assert.ok(sessionCookie, "sets a session cookie");
  assert.match(sessionCookie, /HttpOnly/i);
  assert.match(sessionCookie, /SameSite=Lax/i);
  const data = await res.json();
  assert.equal(data.redirect, "/verify");
  assert.ok(!/token=|session=/i.test(data.redirect), "no token/session in redirect URL");
});

test("mail mode resolves correctly and production never silently uses dev", () => {
  assert.equal(resolveMailMode({}), MAIL_MODES.UNCONFIGURED);
  assert.equal(resolveMailMode({ COFFEEJACK_AUTH_DEV: "1" }), MAIL_MODES.DEV);
  assert.equal(
    resolveMailMode({ COFFEEJACK_SMTP_HOST: "smtp.example.com", COFFEEJACK_SMTP_FROM: "a@b.co" }),
    MAIL_MODES.SMTP,
  );
  // AUTH_DEV set but SMTP also configured => production SMTP wins, not dev.
  assert.equal(
    resolveMailMode({
      COFFEEJACK_SMTP_HOST: "smtp.example.com",
      COFFEEJACK_SMTP_FROM: "a@b.co",
      COFFEEJACK_AUTH_DEV: "1",
    }),
    MAIL_MODES.SMTP,
  );
  // Partial SMTP config without AUTH_DEV must NOT fall back to dev.
  assert.equal(
    resolveMailMode({ COFFEEJACK_SMTP_HOST: "smtp.example.com" }),
    MAIL_MODES.UNCONFIGURED,
  );
});

test("an unconfigured mailer never pretends a message was sent", async () => {
  const mailer = createMailer({ env: {} });
  assert.equal(mailer.mode, MAIL_MODES.UNCONFIGURED);
  const result = await mailer.send({ to: "x@y.z", subject: "s", text: "t" });
  assert.equal(result.delivered, false);
  assert.equal(result.reason, "email_not_configured");
});

test("the dev mailbox endpoint is refused when not in dev mode", async (t) => {
  const mailer = recordingMailer("smtp");
  const { base } = await runningApp(t, { mailer });
  const res = await call(base, "/api/auth/dev/mailbox");
  assert.equal(res.status, 404);
});

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
  return { status: res.status, ok: res.ok, data };
}

test("no plaintext verification code is logged during signup+verify", async (t) => {
  const logs = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const key of Object.keys(original))
    console[key] = (...args) =>
      logs.push(args.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  t.after(() => Object.assign(console, original));

  const mailer = recordingMailer("smtp");
  const { base } = await runningApp(t, { mailer });
  const res = await fetch(base + "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ email: "seclog@example.com", password: "correcthorse" }),
  });
  await res.json();
  Object.assign(console, original);
  const code = (/\b(\d{6})\b/.exec(mailer.sent[0].text) || [])[1];
  assert.ok(code && !logs.join("\n").includes(code));
});
