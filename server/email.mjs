/**
 * Outbound email adapter. Credentials come only from the environment.
 * Production SMTP never falls through to the local dev mailbox.
 */
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

export const MAIL_UNCONFIGURED_MESSAGE =
  "Email delivery is not configured yet. Contact the administrator.";

export function emailConfigured(env = process.env) {
  return Boolean(
    env.COFFEEJACK_SMTP_URL?.trim() || env.COFFEEJACK_SMTP_HOST?.trim(),
  );
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

export function parseSmtpConfig(env = process.env) {
  const url = env.COFFEEJACK_SMTP_URL?.trim();
  if (url) {
    const parsed = new URL(url);
    const secure = parsed.protocol === "smtps:";
    const user = decodeURIComponent(parsed.username || env.COFFEEJACK_SMTP_USER || "");
    const password = decodeURIComponent(
      parsed.password || env.COFFEEJACK_SMTP_PASSWORD || "",
    );
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || (secure ? 465 : 587),
      secure,
      user,
      password,
      from: fromAddress(env, user, parsed.hostname),
    };
  }
  const host = env.COFFEEJACK_SMTP_HOST?.trim();
  if (!host) return null;
  const user = env.COFFEEJACK_SMTP_USER?.trim() || "";
  return {
    host,
    port: 587,
    secure: false,
    user,
    password: env.COFFEEJACK_SMTP_PASSWORD || "",
    from: fromAddress(env, user, host),
  };
}

function fromAddress(env, user, host) {
  if (user.includes("@")) return user;
  return `coffeejack@${host || "localhost"}`;
}

export function buildAuthEmail({
  purpose,
  rawToken,
  publicBase,
  expiresHours,
}) {
  const base = String(publicBase || "").replace(/\/$/, "");
  const isReset = purpose === "reset";
  const pathName = isReset ? "/reset" : "/verify";
  const link = base ? `${base}${pathName}?code=${encodeURIComponent(rawToken)}` : "";
  const hours = expiresHours ?? (isReset ? 1 : 24);
  const lines = [
    "CoffeeJack",
    "",
    isReset
      ? "A password reset was requested for this CoffeeJack account."
      : "Verify your email to finish creating your CoffeeJack account.",
    "",
    isReset ? "Reset code:" : "Verification code:",
    rawToken,
    "",
  ];
  if (link) {
    lines.push(isReset ? "Or open this reset link:" : "Or open this verification link:");
    lines.push(link);
    lines.push("");
  }
  lines.push(`This code expires in ${hours} hour${hours === 1 ? "" : "s"}.`);
  lines.push("");
  lines.push(
    isReset
      ? "If you did not request a password reset, ignore this message."
      : "If you did not create a CoffeeJack account, ignore this message.",
  );
  return lines.join("\n");
}

async function smtpCommand(socket, command) {
  if (command !== undefined) socket.write(command.endsWith("\r\n") ? command : `${command}\r\n`);
  return await readSmtpReply(socket);
}

function readSmtpReply(socket) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const parts = buf.split(/\r?\n/).filter(Boolean);
      const last = parts[parts.length - 1] || "";
      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: buf });
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function connectSmtp(config) {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host })
      : net.connect({ host: config.host, port: config.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("SMTP connection timed out"));
    }, 20000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setEncoding("utf8");
      resolve(socket);
    });
  });
}

function upgradeToTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => resolve(secure));
    secure.once("error", reject);
    secure.setEncoding("utf8");
  });
}

export async function sendSmtpMail(config, { to, subject, text }) {
  if (!config?.host) throw new Error("SMTP is not configured");
  let socket = await connectSmtp(config);
  try {
    const greet = await readSmtpReply(socket);
    if (greet.code !== 220) throw new Error(`SMTP greeting failed (${greet.code})`);
    let ehlo = await smtpCommand(socket, `EHLO coffeejack`);
    if (!config.secure && (ehlo.text.includes("STARTTLS") || config.port === 587)) {
      const start = await smtpCommand(socket, "STARTTLS");
      if (start.code === 220) {
        socket = await upgradeToTls(socket, config.host);
        ehlo = await smtpCommand(socket, `EHLO coffeejack`);
      }
    }
    if (config.user) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo.text)) {
        const payload = Buffer.from(`\0${config.user}\0${config.password}`).toString(
          "base64",
        );
        const auth = await smtpCommand(socket, `AUTH PLAIN ${payload}`);
        if (auth.code !== 235) throw new Error(`SMTP authentication failed (${auth.code})`);
      } else {
        const ready = await smtpCommand(socket, "AUTH LOGIN");
        if (ready.code !== 334) throw new Error(`SMTP AUTH LOGIN rejected (${ready.code})`);
        const userReply = await smtpCommand(
          socket,
          Buffer.from(config.user).toString("base64"),
        );
        if (userReply.code !== 334)
          throw new Error(`SMTP username rejected (${userReply.code})`);
        const passReply = await smtpCommand(
          socket,
          Buffer.from(config.password).toString("base64"),
        );
        if (passReply.code !== 235)
          throw new Error(`SMTP authentication failed (${passReply.code})`);
      }
    }
    const from = config.from;
    const mailFrom = await smtpCommand(socket, `MAIL FROM:<${from}>`);
    if (mailFrom.code !== 250) throw new Error(`SMTP MAIL FROM failed (${mailFrom.code})`);
    const rcpt = await smtpCommand(socket, `RCPT TO:<${to}>`);
    if (rcpt.code !== 250 && rcpt.code !== 251)
      throw new Error(`SMTP RCPT TO failed (${rcpt.code})`);
    const data = await smtpCommand(socket, "DATA");
    if (data.code !== 354) throw new Error(`SMTP DATA failed (${data.code})`);
    const body = [
      `From: CoffeeJack <${from}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      String(text || "").replace(/^\./gm, ".."),
      ".",
    ].join("\r\n");
    const done = await smtpCommand(socket, body);
    if (done.code !== 250) throw new Error(`SMTP send failed (${done.code})`);
    await smtpCommand(socket, "QUIT").catch(() => {});
  } finally {
    socket.destroy();
  }
}

export async function deliverAuthMessage(
  dataDirectory,
  { to, subject, text, purpose, rawToken, publicBase, expiresHours },
  options = {},
) {
  const env = options.env || process.env;
  const status = mailStatus(env);
  const body =
    text ||
    buildAuthEmail({
      purpose,
      rawToken,
      publicBase,
      expiresHours,
    });
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
      if (options.send) await options.send({ to, subject, text: body, purpose });
      else
        await sendSmtpMail(parseSmtpConfig(env), {
          to,
          subject,
          text: body,
        });
      record.delivered = true;
    } catch (error) {
      record.error = error.message || "SMTP send failed";
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
      text: body,
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
