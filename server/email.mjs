/**
 * Outbound email adapter. Credentials come only from the environment.
 * Production SMTP uses Nodemailer and never falls through to the local mailbox.
 */
import fs from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";

export const MAIL_UNCONFIGURED_MESSAGE =
  "Email delivery is not configured yet. Contact the administrator.";

export function emailConfigured(env = process.env) {
  return parseSmtpConfig(env) !== null;
}

export function authDevMode(env = process.env) {
  return env.COFFEEJACK_AUTH_DEV === "1";
}

export function mailStatus(env = process.env) {
  if (emailConfigured(env))
    return {
      configured: true,
      mode: "smtp",
      message: "Verification and reset messages are sent by email.",
    };
  return {
    configured: false,
    mode: authDevMode(env) ? "dev_mailbox" : "unconfigured",
    message: MAIL_UNCONFIGURED_MESSAGE,
  };
}

function truthyFlag(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function falseyFlag(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "no";
}

function fromAddress(env, user, host) {
  const explicit = env.COFFEEJACK_SMTP_FROM?.trim();
  if (explicit) return explicit;
  if (user.includes("@")) return user;
  return `coffeejack@${host || "localhost"}`;
}

function parseSecure(env, { urlSecure, port }) {
  if (truthyFlag(env.COFFEEJACK_SMTP_SECURE)) return true;
  if (falseyFlag(env.COFFEEJACK_SMTP_SECURE)) return false;
  if (urlSecure) return true;
  return Number(port) === 465;
}

export function parseSmtpConfig(env = process.env) {
  const url = env.COFFEEJACK_SMTP_URL?.trim();
  if (url) {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname) return null;
      const urlSecure = parsed.protocol === "smtps:";
      const user = decodeURIComponent(
        parsed.username || env.COFFEEJACK_SMTP_USER || "",
      );
      const password = decodeURIComponent(
        parsed.password || env.COFFEEJACK_SMTP_PASSWORD || "",
      );
      const port = Number(parsed.port) || (urlSecure ? 465 : 587);
      const secure = parseSecure(env, { urlSecure, port });
      return {
        host: parsed.hostname,
        port,
        secure,
        user,
        password,
        from: fromAddress(env, user, parsed.hostname),
      };
    } catch {
      return null;
    }
  }
  const host = env.COFFEEJACK_SMTP_HOST?.trim();
  if (!host) return null;
  const user = env.COFFEEJACK_SMTP_USER?.trim() || "";
  const secureHint = truthyFlag(env.COFFEEJACK_SMTP_SECURE);
  const port = Number(env.COFFEEJACK_SMTP_PORT) || (secureHint ? 465 : 587);
  const secure = parseSecure(env, { urlSecure: false, port });
  return {
    host,
    port,
    secure,
    user,
    password: env.COFFEEJACK_SMTP_PASSWORD || "",
    from: fromAddress(env, user, host),
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char],
  );
}

export function buildAuthEmail({
  purpose,
  rawToken,
  publicBase,
  expiresMinutes,
}) {
  const base = String(publicBase || "").replace(/\/$/, "");
  const isReset = purpose === "reset";
  const pathName = isReset ? "/reset" : "/verify";
  const pageUrl = base ? `${base}${pathName}` : pathName;
  const minutes = expiresMinutes ?? (isReset ? 30 : 15);
  const heading = isReset
    ? "A password reset was requested for this CoffeeJack account."
    : "Verify your email to finish creating your CoffeeJack account.";
  const label = isReset ? "Reset code:" : "Verification code:";
  const ignore = isReset
    ? "If you did not request a password reset, ignore this message."
    : "If you did not create a CoffeeJack account, ignore this message.";
  const expiry = `This code expires in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  const open = isReset
    ? `Open the reset page and enter this code: ${pageUrl}`
    : `Open the verification page and enter this code: ${pageUrl}`;
  const text = [
    "CoffeeJack",
    "",
    heading,
    "",
    label,
    rawToken,
    "",
    open,
    "",
    expiry,
    "",
    ignore,
  ].join("\n");
  const html = [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8"><title>CoffeeJack</title></head>',
    '<body style="font-family:Segoe UI,Tahoma,sans-serif;line-height:1.5;color:#1b1b1b;background:#fff;margin:0;padding:24px;">',
    "<p style=\"font-weight:700;letter-spacing:0.08em;margin:0 0 16px;\">CoffeeJack</p>",
    `<p>${escapeHtml(heading)}</p>`,
    `<p>${escapeHtml(label)}</p>`,
    `<p style="font-size:28px;letter-spacing:0.35em;font-weight:700;margin:8px 0 20px;">${escapeHtml(rawToken)}</p>`,
    `<p>Open the ${isReset ? "reset" : "verification"} page and enter this code:<br><a href="${escapeHtml(pageUrl)}">${escapeHtml(pageUrl)}</a></p>`,
    `<p>${escapeHtml(expiry)}</p>`,
    `<p>${escapeHtml(ignore)}</p>`,
    "</body></html>",
  ].join("");
  return { text, html };
}

export function redactSmtpError(error, config = {}) {
  let message = error?.message || "SMTP send failed";
  const secrets = [config.password, config.user, config.from].filter(Boolean);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(/(pass(?:word)?|pwd|secret|auth)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]");
}

export async function sendSmtpMail(config, { to, subject, text, html }, options = {}) {
  if (!config?.host) throw new Error("SMTP is not configured");
  const factory = options.transportFactory || ((opts) => nodemailer.createTransport(opts));
  const transporter = factory({
    host: config.host,
    port: config.port,
    secure: Boolean(config.secure),
    auth: config.user
      ? { user: config.user, pass: config.password }
      : undefined,
  });
  try {
    await transporter.sendMail({
      from: `CoffeeJack <${config.from}>`,
      to,
      subject,
      text,
      html,
    });
  } catch (error) {
    throw new Error(redactSmtpError(error, config));
  }
}

export async function deliverAuthMessage(
  dataDirectory,
  { to, subject, text, html, purpose, rawToken, publicBase, expiresMinutes },
  options = {},
) {
  const env = options.env || process.env;
  const status = mailStatus(env);
  const built =
    text && html
      ? { text, html }
      : buildAuthEmail({
          purpose,
          rawToken,
          publicBase,
          expiresMinutes,
        });
  const bodyText = text || built.text;
  const bodyHtml = html || built.html;
  const record = {
    to,
    subject,
    purpose,
    created: new Date().toISOString(),
    delivered: false,
    configured: status.configured || Boolean(options.send),
  };
  const useProvider = Boolean(options.send) || status.configured;
  if (useProvider) {
    try {
      if (options.send)
        await options.send({
          to,
          subject,
          text: bodyText,
          html: bodyHtml,
          purpose,
        });
      else
        await sendSmtpMail(
          parseSmtpConfig(env),
          { to, subject, text: bodyText, html: bodyHtml },
          options,
        );
      record.delivered = true;
    } catch (error) {
      record.error = redactSmtpError(error, parseSmtpConfig(env) || {});
    }
    return {
      configured: true,
      mode: "smtp",
      message: record.delivered
        ? status.message
        : record.error || "Email delivery failed.",
      record,
    };
  }
  if (authDevMode(env) && dataDirectory) {
    const file = path.join(dataDirectory, "auth-dev-mailbox.json");
    let box = [];
    try {
      box = JSON.parse(await fs.readFile(file, "utf8"));
      if (!Array.isArray(box)) box = [];
    } catch {
      box = [];
    }
    box.push({
      ...record,
      text: bodyText,
      html: bodyHtml,
      token: rawToken,
    });
    await fs.mkdir(dataDirectory, { recursive: true });
    await fs.writeFile(file, JSON.stringify(box.slice(-40), null, 2));
    record.devStored = true;
  }
  return { ...status, record };
}

export async function readDevMailbox(dataDirectory) {
  if (!authDevMode()) return [];
  try {
    const file = path.join(dataDirectory, "auth-dev-mailbox.json");
    const box = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(box) ? box : [];
  } catch {
    return [];
  }
}
