import { createPublicKey, verify } from "node:crypto";

function emailOk(email) {
  return (
    typeof email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  );
}

/**
 * Validate Cloudflare Access env without returning secret values.
 * @returns {{ ok: boolean, mode: 'disabled'|'ready'|'incomplete', issues: string[], summary: object }}
 */
export function validateAccessEnvironment(env = process.env) {
  const host = env.COFFEEJACK_REMOTE_HOST?.trim() || "";
  const team = env.CF_ACCESS_TEAM_DOMAIN?.trim() || "";
  const aud = env.CF_ACCESS_AUD?.trim() || "";
  const emailsRaw = env.CF_ACCESS_ALLOWED_EMAILS?.trim() || "";
  const ownerEmail = env.CF_ACCESS_OWNER_EMAIL?.trim() || "";
  const autoCreate = env.CF_ACCESS_AUTO_CREATE_ROLE?.trim() || "";
  const present = [host, team, aud, emailsRaw].filter(Boolean).length;
  const issues = [];
  const summary = {
    COFFEEJACK_REMOTE_HOST: host ? "set" : "missing",
    CF_ACCESS_TEAM_DOMAIN: team ? "set" : "missing",
    CF_ACCESS_AUD: aud ? "set" : "missing",
    CF_ACCESS_ALLOWED_EMAILS: emailsRaw ? "set" : "missing",
    CF_ACCESS_OWNER_EMAIL: ownerEmail ? "set" : "optional_missing",
    CF_ACCESS_AUTO_CREATE_ROLE: autoCreate || "off",
  };

  if (present === 0) {
    return { ok: true, mode: "disabled", issues: [], summary };
  }
  if (present < 4) {
    issues.push(
      "Incomplete Cloudflare Access config: set COFFEEJACK_REMOTE_HOST, CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, and CF_ACCESS_ALLOWED_EMAILS together (or leave all unset for local-only).",
    );
  }
  if (host) {
    if (
      !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
        host,
      ) ||
      host.endsWith(".localhost")
    )
      issues.push("COFFEEJACK_REMOTE_HOST must be a public lowercase hostname.");
  }
  if (team && !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team))
    issues.push(
      "CF_ACCESS_TEAM_DOMAIN must look like team-name.cloudflareaccess.com.",
    );
  if (aud && !/^[a-f0-9]{64}$/.test(aud))
    issues.push("CF_ACCESS_AUD must be the 64-character hex application audience.");
  if (emailsRaw) {
    const emails = emailsRaw.split(",").map((e) => e.trim()).filter(Boolean);
    if (!emails.length || emails.some((e) => !emailOk(e)))
      issues.push(
        "CF_ACCESS_ALLOWED_EMAILS must be a comma-separated list of valid emails.",
      );
  }
  if (ownerEmail && !emailOk(ownerEmail))
    issues.push("CF_ACCESS_OWNER_EMAIL must be a valid email when set.");
  if (autoCreate && autoCreate !== "standard")
    issues.push('CF_ACCESS_AUTO_CREATE_ROLE must be unset or "standard".');

  return {
    ok: issues.length === 0,
    mode: issues.length ? "incomplete" : "ready",
    issues,
    summary,
  };
}

// Remote access is opt-in. Never trust a forwarded hostname or an unsigned identity header.
export function accessFromEnvironment(env = process.env) {
  const check = validateAccessEnvironment(env);
  if (check.mode === "disabled") return null;
  if (!check.ok) {
    throw new Error(
      "Cloudflare Access configuration invalid:\n- " + check.issues.join("\n- "),
    );
  }
  return createAccessGuard({
    hostname: env.COFFEEJACK_REMOTE_HOST.trim(),
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN.trim(),
    audience: env.CF_ACCESS_AUD.trim(),
    emails: env.CF_ACCESS_ALLOWED_EMAILS.split(","),
  });
}

export function createAccessGuard(
  { hostname, teamDomain, audience, emails },
  { fetcher = fetch, now = Date.now } = {},
) {
  if (
    typeof hostname !== "string" ||
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      hostname,
    ) ||
    hostname.endsWith(".localhost")
  )
    throw new Error("Invalid remote hostname");
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain ?? ""))
    throw new Error("Invalid Access team domain");
  if (typeof audience !== "string" || !/^[a-f0-9]{64}$/.test(audience))
    throw new Error("Invalid Access audience");
  if (
    !Array.isArray(emails) ||
    !emails.length ||
    emails.some(
      (email) =>
        typeof email !== "string" ||
        !emailOk(email),
    )
  )
    throw new Error("Explicit allowed email identities are required");
  const allowed = new Set(emails.map((email) => email.trim().toLowerCase()));
  const issuer = `https://${teamDomain}`;
  let cached = [],
    validUntil = 0,
    pending;
  async function keys() {
    if (now() < validUntil) return cached;
    if (!pending)
      pending = (async () => {
        const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
        if (!response.ok) throw new Error("Access key service unavailable");
        const data = await response.json();
        if (!Array.isArray(data.keys) || data.keys.length > 20)
          throw new Error("Invalid signing keys");
        cached = data.keys.filter(
          (key) => key.kty === "RSA" && (!key.use || key.use === "sig"),
        );
        validUntil = now() + 60000;
        return cached;
      })().finally(() => {
        pending = null;
      });
    return pending;
  }
  return {
    hostname,
    issuer,
    audience,
    async authorize(req) {
      try {
        const token = req.headers["cf-access-jwt-assertion"];
        if (typeof token !== "string" || token.length > 16000) return false;
        const parts = token.split(".");
        if (
          parts.length !== 3 ||
          parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
        )
          return false;
        const header = JSON.parse(Buffer.from(parts[0], "base64url"));
        const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
        if (header.alg !== "RS256" || typeof header.kid !== "string")
          return false;
        const seconds = now() / 1000;
        if (
          claims.iss !== issuer ||
          !Number.isFinite(claims.exp) ||
          claims.exp <= seconds ||
          (claims.nbf !== undefined &&
            (!Number.isFinite(claims.nbf) || claims.nbf > seconds))
        )
          return false;
        const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (
          !audiences.includes(audience) ||
          typeof claims.email !== "string" ||
          !allowed.has(claims.email.toLowerCase())
        )
          return false;
        const key = (await keys()).find((key) => key.kid === header.kid);
        if (!key) return false;
        const ok = verify(
          "RSA-SHA256",
          Buffer.from(parts[0] + "." + parts[1]),
          createPublicKey({ key, format: "jwk" }),
          Buffer.from(parts[2], "base64url"),
        );
        if (!ok) return false;
        // Unsigned email headers are never used — only verified JWT claims.
        return {
          email: claims.email.trim().toLowerCase(),
          subject: String(claims.sub || claims.email).trim(),
          issuer: claims.iss,
          audience: claims.aud,
        };
      } catch {
        return false;
      }
    },
  };
}
