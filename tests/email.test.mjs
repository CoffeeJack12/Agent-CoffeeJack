import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAIL_UNCONFIGURED_MESSAGE,
  buildAuthEmail,
  deliverAuthMessage,
  mailStatus,
  parseSmtpConfig,
  sendSmtpMail,
} from "../server/email.mjs";

test("missing SMTP reports honest unconfigured state", () => {
  const status = mailStatus({ COFFEEJACK_AUTH_DEV: "1" });
  assert.equal(status.configured, false);
  assert.equal(status.mode, "dev_mailbox");
  assert.equal(status.message, MAIL_UNCONFIGURED_MESSAGE);
  assert.equal(mailStatus({}).message, MAIL_UNCONFIGURED_MESSAGE);
  assert.equal(mailStatus({}).mode, "unconfigured");
});

test("parseSmtpConfig reads URL and discrete production variables", () => {
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
    COFFEEJACK_SMTP_PORT: "2525",
    COFFEEJACK_SMTP_USER: "noreply@example.com",
    COFFEEJACK_SMTP_PASSWORD: "secret",
    COFFEEJACK_SMTP_FROM: "CoffeeJack <hello@example.com>",
    COFFEEJACK_SMTP_SECURE: "1",
  });
  assert.equal(discrete.host, "smtp.example.com");
  assert.equal(discrete.port, 2525);
  assert.equal(discrete.secure, true);
  assert.equal(discrete.from, "CoffeeJack <hello@example.com>");
  assert.equal(parseSmtpConfig({ COFFEEJACK_SMTP_URL: "not-a-url" }), null);
  assert.equal(parseSmtpConfig({}), null);
});

test("verification and reset emails include branding, 6-digit code, HTML+text, no query secret", () => {
  const verify = buildAuthEmail({
    purpose: "verify",
    rawToken: "123456",
    publicBase: "https://coffeejack-agent.com",
    expiresMinutes: 15,
  });
  assert.match(verify.text, /CoffeeJack/);
  assert.match(verify.text, /123456/);
  assert.match(verify.text, /15 minutes/);
  assert.match(verify.text, /ignore this message/i);
  assert.match(verify.text, /https:\/\/coffeejack-agent.com\/verify/);
  assert.doesNotMatch(verify.text, /\?code=/);
  assert.match(verify.html, /CoffeeJack/);
  assert.match(verify.html, /123456/);
  assert.match(verify.html, /15 minutes/);
  assert.doesNotMatch(verify.html, /\?code=/);
  const reset = buildAuthEmail({
    purpose: "reset",
    rawToken: "654321",
    publicBase: "https://coffeejack-agent.com",
    expiresMinutes: 30,
  });
  assert.match(reset.text, /654321/);
  assert.match(reset.text, /30 minutes/);
  assert.match(reset.html, /654321/);
  assert.doesNotMatch(reset.text, /\?code=/);
});

test("configured mail provider sends HTML+text; AUTH_DEV mailbox is not used", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-mail-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sent = [];
  const result = await deliverAuthMessage(
    dir,
    {
      to: "user@example.com",
      subject: "Verify your CoffeeJack account",
      purpose: "verify",
      rawToken: "123456",
      publicBase: "http://127.0.0.1:3210",
      expiresMinutes: 15,
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
  assert.equal(result.mode, "smtp");
  assert.equal(result.record.delivered, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /CoffeeJack/);
  assert.match(sent[0].html, /CoffeeJack/);
  assert.match(sent[0].text, /123456/);
  assert.equal(result.record.token, undefined);
  assert.doesNotMatch(JSON.stringify(result.record), /123456/);
  await assert.rejects(() => fs.readFile(path.join(dir, "auth-dev-mailbox.json")));
});

test("production SMTP uses Nodemailer and redacts credentials", async () => {
  const src = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../server/email.mjs"),
    "utf8",
  );
  assert.match(src, /import nodemailer from ["']nodemailer["']/);
  assert.doesNotMatch(src, /net\.connect|tls\.connect|AUTH PLAIN/);
  const pkg = JSON.parse(
    await fs.readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"),
      "utf8",
    ),
  );
  assert.ok(pkg.dependencies.nodemailer);

  let transportOpts;
  const sent = [];
  await sendSmtpMail(
    {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "jack@example.com",
      password: "super-secret-pass",
      from: "jack@example.com",
    },
    { to: "user@example.com", subject: "Hi", text: "plain", html: "<p>html</p>" },
    {
      transportFactory: (opts) => {
        transportOpts = opts;
        return {
          sendMail: async (message) => {
            sent.push(message);
            return { messageId: "test" };
          },
        };
      },
    },
  );
  assert.equal(transportOpts.host, "smtp.example.com");
  assert.equal(transportOpts.auth.user, "jack@example.com");
  assert.equal(transportOpts.auth.pass, "super-secret-pass");
  assert.equal(sent[0].text, "plain");
  assert.equal(sent[0].html, "<p>html</p>");

  await assert.rejects(
    () =>
      sendSmtpMail(
        {
          host: "smtp.example.com",
          port: 587,
          user: "jack@example.com",
          password: "super-secret-pass",
          from: "jack@example.com",
        },
        { to: "user@example.com", subject: "Hi", text: "x", html: "<p>x</p>" },
        {
          transportFactory: () => ({
            sendMail: async () => {
              throw new Error(
                "auth failed password=super-secret-pass user=jack@example.com",
              );
            },
          }),
        },
      ),
    (error) => {
      assert.doesNotMatch(error.message, /super-secret-pass/);
      assert.doesNotMatch(error.message, /jack@example.com/);
      return true;
    },
  );
});

test("dev mailbox remains AUTH_DEV only and stores HTML+text locally", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-devmail-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const result = await deliverAuthMessage(
    dir,
    {
      to: "dev@example.com",
      subject: "Verify your CoffeeJack account",
      purpose: "verify",
      rawToken: "424242",
      publicBase: "http://127.0.0.1:3210",
    },
    { env: { COFFEEJACK_AUTH_DEV: "1" } },
  );
  assert.equal(result.configured, false);
  assert.equal(result.mode, "dev_mailbox");
  assert.equal(result.record.devStored, true);
  const box = JSON.parse(
    await fs.readFile(path.join(dir, "auth-dev-mailbox.json"), "utf8"),
  );
  assert.match(box[0].text, /424242/);
  assert.match(box[0].html, /424242/);
});
