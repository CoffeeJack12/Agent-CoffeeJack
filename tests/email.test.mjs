import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAIL_UNCONFIGURED_MESSAGE,
  buildAuthEmail,
  deliverAuthMessage,
  mailStatus,
  parseSmtpConfig,
} from "../server/email.mjs";

test("missing SMTP reports honest unconfigured state", () => {
  const status = mailStatus({ COFFEEJACK_AUTH_DEV: "1" });
  assert.equal(status.configured, false);
  assert.equal(status.message, MAIL_UNCONFIGURED_MESSAGE);
  assert.equal(mailStatus({}).message, MAIL_UNCONFIGURED_MESSAGE);
});

test("parseSmtpConfig reads URL and discrete host variables", () => {
  const fromUrl = parseSmtpConfig({
    COFFEEJACK_SMTP_URL: "smtps://jack%40ex.com:p%40ss@mail.example.com:465",
  });
  assert.equal(fromUrl.host, "mail.example.com");
  assert.equal(fromUrl.port, 465);
  assert.equal(fromUrl.secure, true);
  assert.equal(fromUrl.user, "jack@ex.com");
  assert.equal(fromUrl.password, "p@ss");
  assert.equal(fromUrl.from, "jack@ex.com");
  const discrete = parseSmtpConfig({
    COFFEEJACK_SMTP_HOST: "smtp.example.com",
    COFFEEJACK_SMTP_USER: "noreply@example.com",
    COFFEEJACK_SMTP_PASSWORD: "secret",
  });
  assert.equal(discrete.host, "smtp.example.com");
  assert.equal(discrete.port, 587);
  assert.equal(discrete.from, "noreply@example.com");
});

test("verification email includes branding, code, expiry, and ignore notice", () => {
  const text = buildAuthEmail({
    purpose: "verify",
    rawToken: "abc-verify-token",
    publicBase: "https://coffeejack-agent.com",
    expiresHours: 24,
  });
  assert.match(text, /CoffeeJack/);
  assert.match(text, /abc-verify-token/);
  assert.match(text, /24 hour/);
  assert.match(text, /ignore this message/i);
  assert.match(text, /https:\/\/coffeejack-agent.com\/verify\?code=abc-verify-token/);
});

test("configured mail provider sends verification message; AUTH_DEV is not used", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-mail-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sent = [];
  const result = await deliverAuthMessage(
    dir,
    {
      to: "user@example.com",
      subject: "Verify your CoffeeJack account",
      purpose: "verify",
      rawToken: "raw-secret-token",
      publicBase: "http://127.0.0.1:3210",
    },
    {
      env: {
        COFFEEJACK_SMTP_HOST: "smtp.example.com",
        COFFEEJACK_SMTP_USER: "jack@example.com",
        COFFEEJACK_SMTP_PASSWORD: "secret",
        COFFEEJACK_AUTH_DEV: "1",
      },
      send: async (message) => {
        sent.push(message);
      },
    },
  );
  assert.equal(result.configured, true);
  assert.equal(result.record.delivered, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /CoffeeJack/);
  assert.match(sent[0].text, /raw-secret-token/);
  await assert.rejects(() => fs.readFile(path.join(dir, "auth-dev-mailbox.json")));
});
