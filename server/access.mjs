import { createPublicKey, verify } from "node:crypto";

// Remote access is opt-in. Never trust a forwarded hostname or an unsigned identity header.
export function accessFromEnvironment(env = process.env) {
  const values = [
    env.COFFEEJACK_REMOTE_HOST,
    env.CF_ACCESS_TEAM_DOMAIN,
    env.CF_ACCESS_AUD,
    env.CF_ACCESS_ALLOWED_EMAILS,
  ];
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value))
    throw new Error(
      "Remote access requires hostname, Access team domain, audience and allowed emails",
    );
  return createAccessGuard({
    hostname: values[0],
    teamDomain: values[1],
    audience: values[2],
    emails: values[3].split(","),
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
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()),
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
        return verify(
          "RSA-SHA256",
          Buffer.from(parts[0] + "." + parts[1]),
          createPublicKey({ key, format: "jwk" }),
          Buffer.from(parts[2], "base64url"),
        );
      } catch {
        return false;
      }
    },
  };
}
