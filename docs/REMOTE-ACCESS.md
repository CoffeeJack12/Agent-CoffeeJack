# Optional Cloudflare remote access

Status: application-side Access JWT verification, identity mapping, tunnel-aware trust classification, remote session hardening and readiness tooling are implemented. Live Tunnel/DNS/Access provisioning remain operator steps. See [CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md).

## Trust boundary (critical)

```text
DIRECT LOOPBACK  Host 127.0.0.1/localhost, no Cloudflare markers
                 → local owner bootstrap OK

TUNNEL / REMOTE  Host = COFFEEJACK_REMOTE_HOST
              or loopback Host + CF markers (Cf-Ray, Cf-Connecting-IP, Access JWT, …)
                 → remote path only
                 → verified JWT required
                 → map identity → session
                 → NEVER local-owner bootstrap

X-Forwarded-For / X-Real-IP / spoofed email headers
                 → never proof of locality or identity
```

Intended origin for the tunnel service: **http://127.0.0.1:3210**. Ollama stays on **127.0.0.1:11434** and must not be tunnelled.

## Configuration

| Value | Purpose |
| --- | --- |
| `COFFEEJACK_REMOTE_HOST` | Public hostname |
| `CF_ACCESS_TEAM_DOMAIN` | Access team domain |
| `CF_ACCESS_AUD` | 64-hex application audience |
| `CF_ACCESS_ALLOWED_EMAILS` | JWT email allowlist |
| `CF_ACCESS_OWNER_EMAIL` | Optional owner auto-link |
| `CF_ACCESS_AUTO_CREATE_ROLE` | Optional `standard` auto-create |

`validateAccessEnvironment` / startup fail closed on incomplete config. Templates: `deploy/cloudflare/`.

## Readiness

```bat
npm.cmd run remote:check
npm.cmd run test:remote-acceptance
```

## Sessions and headers

Remote sessions: source=`remote`, ~24h TTL, HttpOnly Secure cookie + `X-CoffeeJack-Token`. Logout and mapping loss revoke sessions. Sensitive remote routes use light rate limits. API responses set `Cache-Control: no-store` and standard security headers (CSP, nosniff, frame deny, Referrer-Policy, Permissions-Policy).

## Live Cloudflare

Real end-to-end Tunnel + Access browser login requires operator credentials. Automated tests use mocked JWTs only.
