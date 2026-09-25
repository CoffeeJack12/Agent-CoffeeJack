// Outbound email abstraction with three explicit modes:
//   - "smtp"         : real delivery via SMTP (production). No hardcoded creds.
//   - "dev"          : local dev mailbox (opt-in with COFFEEJACK_AUTH_DEV=1).
//   - "unconfigured" : nothing is configured; the app must be honest about it
//                      and never pretend a message was sent.
//
// Production never silently falls back to the dev mailbox: dev mode is only
// active when explicitly requested AND no SMTP host/from is configured.

export const MAIL_MODES = Object.freeze({
  SMTP: "smtp",
  DEV: "dev",
  UNCONFIGURED: "unconfigured",
});

// The exact SMTP/email environment variables CoffeeJack reads.
export const MAIL_ENV_VARS = Object.freeze([
  "COFFEEJACK_SMTP_HOST",
  "COFFEEJACK_SMTP_PORT",
  "COFFEEJACK_SMTP_USER",
  "COFFEEJACK_SMTP_PASS",
  "COFFEEJACK_SMTP_FROM",
  "COFFEEJACK_SMTP_SECURE",
  "COFFEEJACK_AUTH_DEV",
  "COFFEEJACK_BASE_URL",
]);

export function resolveMailMode(env = process.env) {
  const host = (env.COFFEEJACK_SMTP_HOST || "").trim();
  const from = (env.COFFEEJACK_SMTP_FROM || "").trim();
  if (host && from) return MAIL_MODES.SMTP;
  if (env.COFFEEJACK_AUTH_DEV === "1") return MAIL_MODES.DEV;
  return MAIL_MODES.UNCONFIGURED;
}

function smtpConfig(env) {
  return {
    host: (env.COFFEEJACK_SMTP_HOST || "").trim(),
    port: Number(env.COFFEEJACK_SMTP_PORT || 587),
    secure: env.COFFEEJACK_SMTP_SECURE === "true",
    user: env.COFFEEJACK_SMTP_USER || "",
    pass: env.COFFEEJACK_SMTP_PASS || "",
    from: (env.COFFEEJACK_SMTP_FROM || "").trim(),
  };
}

/**
 * Build a mailer. `devMailbox` is an array the dev mode appends rendered
 * messages to (so local development and tests can read the code without SMTP).
 */
export function createMailer({ env = process.env, devMailbox } = {}) {
  const mode = resolveMailMode(env);

  if (mode === MAIL_MODES.SMTP) {
    const config = smtpConfig(env);
    let transportPromise = null;
    const transport = async () => {
      if (!transportPromise) {
        transportPromise = import("nodemailer").then((mod) =>
          (mod.default || mod).createTransport({
            host: config.host,
            port: config.port,
            secure: config.secure,
            auth: config.user ? { user: config.user, pass: config.pass } : undefined,
          }),
        );
      }
      return transportPromise;
    };
    return {
      mode,
      from: config.from,
      async send({ to, subject, text, html }) {
        const mailer = await transport();
        const info = await mailer.sendMail({
          from: config.from,
          to,
          subject,
          text,
          html,
        });
        return { delivered: true, mode, id: info?.messageId || null };
      },
    };
  }

  if (mode === MAIL_MODES.DEV) {
    const box = Array.isArray(devMailbox) ? devMailbox : [];
    return {
      mode,
      from: "coffeejack-dev@localhost",
      mailbox: box,
      async send(message) {
        box.push({ ...message, sentAt: new Date().toISOString() });
        if (box.length > 50) box.splice(0, box.length - 50);
        return { delivered: true, mode, id: `dev-${box.length}` };
      },
    };
  }

  return {
    mode,
    from: null,
    // Honest no-op: never claim delivery when nothing is configured.
    async send() {
      return {
        delivered: false,
        mode,
        reason: "email_not_configured",
      };
    },
  };
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

function brandedHtml({ heading, code, expiresMinutes, baseUrl, intro, action }) {
  const safeCode = escapeHtml(code);
  const link = `${baseUrl}/verify`;
  return `<!doctype html><html><body style="margin:0;background:#0b0b10;font-family:Segoe UI,Arial,sans-serif;color:#e8e8ef">
  <div style="max-width:480px;margin:0 auto;padding:32px 24px">
    <div style="font-size:22px;font-weight:700;letter-spacing:1px;color:#b794f6">CoffeeJack</div>
    <h1 style="font-size:18px;font-weight:600;margin:20px 0 8px">${escapeHtml(heading)}</h1>
    <p style="color:#b8b8c4;line-height:1.5;margin:0 0 20px">${escapeHtml(intro)}</p>
    <div style="font-size:30px;font-weight:700;letter-spacing:8px;background:#16161f;border:1px solid #2a2a38;border-radius:10px;padding:16px;text-align:center;color:#fff">${safeCode}</div>
    <p style="color:#8a8a99;font-size:13px;margin:16px 0">This code expires in ${expiresMinutes} minutes. ${escapeHtml(action)} <a style="color:#b794f6" href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
    <hr style="border:none;border-top:1px solid #23232f;margin:24px 0"/>
    <p style="color:#6b6b78;font-size:12px;line-height:1.5">If you did not request this, you can safely ignore this email — no changes will be made to any account.</p>
  </div></body></html>`;
}

export function verificationEmail({ code, expiresMinutes, baseUrl = "http://127.0.0.1:3210" }) {
  const subject = "Verify your CoffeeJack account";
  const text = [
    "CoffeeJack",
    "",
    "Confirm your email address to finish setting up your account.",
    "",
    `Your verification code is: ${code}`,
    `This code expires in ${expiresMinutes} minutes.`,
    `Enter it at ${baseUrl}/verify`,
    "",
    "If you did not create a CoffeeJack account, you can safely ignore this email.",
  ].join("\n");
  const html = brandedHtml({
    heading: "Confirm your email address",
    code,
    expiresMinutes,
    baseUrl,
    intro: "Confirm your email address to finish setting up your CoffeeJack account.",
    action: "Enter it at",
  });
  return { subject, text, html };
}

export function passwordResetEmail({ code, expiresMinutes, baseUrl = "http://127.0.0.1:3210" }) {
  const subject = "Reset your CoffeeJack password";
  const text = [
    "CoffeeJack",
    "",
    "We received a request to reset your password.",
    "",
    `Your password reset code is: ${code}`,
    `This code expires in ${expiresMinutes} minutes.`,
    "",
    "If you did not request a password reset, you can safely ignore this email.",
  ].join("\n");
  const html = brandedHtml({
    heading: "Reset your password",
    code,
    expiresMinutes,
    baseUrl,
    intro: "We received a request to reset your CoffeeJack password.",
    action: "Continue at",
  });
  return { subject, text, html };
}
