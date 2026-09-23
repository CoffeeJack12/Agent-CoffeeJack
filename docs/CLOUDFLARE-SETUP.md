# Cloudflare Tunnel + Access setup (operator)

CoffeeJack stays bound to **http://127.0.0.1:3210**. Cloudflare Tunnel forwards public HTTPS to that loopback origin. **Never** put Ollama (`127.0.0.1:11434`) on the tunnel.

```text
Browser → Cloudflare Access (JWT) → Cloudflare Tunnel → 127.0.0.1:3210 → CoffeeJack
                                                              ↘ (local only) Ollama :11434
```

## 0. Readiness check

```bat
npm.cmd run remote:check
```

Fix every **FAIL**. **WARN** items are acceptable before first start / before installing `cloudflared`.

## 1. Environment variables

Copy `deploy/cloudflare/env.example` to a private env file (never commit):

| Variable | Required | Purpose |
| --- | --- | --- |
| `COFFEEJACK_REMOTE_HOST` | yes (for remote) | Public hostname, lowercase, no scheme |
| `CF_ACCESS_TEAM_DOMAIN` | yes | `team.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | yes | Access application audience (64 hex) |
| `CF_ACCESS_ALLOWED_EMAILS` | yes | Comma-separated emails in JWT `email` claim |
| `CF_ACCESS_OWNER_EMAIL` | recommended | Verified email that may auto-link to local owner |
| `CF_ACCESS_AUTO_CREATE_ROLE` | no | Set `standard` only if you want auto-create; default pending |
| `COFFEEJACK_PORT` | no | Default `3210` |

Incomplete sets of the four required values **prevent startup** (fail closed).

## 2. Access application

1. Cloudflare Zero Trust → Access → Applications → Add self-hosted.
2. Application domain: exact `COFFEEJACK_REMOTE_HOST` (all paths).
3. Identity provider: your IdP (Google/GitHub/OTP, etc.) with MFA.
4. Policy: allow only known emails (owner + TestUser, …). No Bypass / Everyone.
5. Session duration: choose e.g. 24h (CoffeeJack remote sessions also expire ~24h).
6. Copy the application **AUD** into `CF_ACCESS_AUD`.

## 3. Tunnel

1. Create a remotely managed Tunnel.
2. Public hostname → service `http://127.0.0.1:3210`.
3. Keep Host header as the public hostname (`noHostHeader: false`). Rewriting Host to `localhost` is unsafe; CoffeeJack treats CF markers on loopback as **remote** and requires a valid JWT (never local-owner bootstrap).
4. Enable Tunnel **Protect with Access** with the same audience when available.
5. Install `cloudflared` on the Windows host; run with `--token-file` pointing at a restricted local secret file **outside** the repo.

Template: `deploy/cloudflare/tunnel.example.yml`.

## 4. First owner remote login

1. Start CoffeeJack locally (`npm.cmd start`) with env set.
2. Open `https://<COFFEEJACK_REMOTE_HOST>` and complete Access login as `CF_ACCESS_OWNER_EMAIL`.
3. CoffeeJack maps the verified subject to the existing **Abdulrahman** owner (no duplicate) when owner email auto-link is configured, or use owner `POST /api/identity/link` from a local session.
4. UI should show **Owner · Cloudflare**.

## 5. TestUser

1. Create local user **TestUser** (role `standard`) or allow Access email + link identity.
2. Link Cloudflare subject/email to that user (owner link API or auto-create).
3. Confirm workspace is under `.local/workspaces/<user-id>/` and owner repo is not listed.
4. Ask Jack to fix a fixture test only inside that workspace.

## 6. Verify fail-closed cases

- No JWT / invalid / expired / wrong AUD / wrong issuer → 403
- Unknown verified identity → `pending_identity`
- Disabled user / unlinked identity → 403
- Spoofed `Cf-Access-Authenticated-User-Email` without JWT → denied
- Tunnel markers on `127.0.0.1` without valid JWT → denied (not local owner)

## 7. Session token note

APIs accept `X-CoffeeJack-Token` (in-memory from `/api/status`) for compatibility. Remote status also sets an **HttpOnly Secure** `coffeejack_session` cookie. Tokens are redacted from audit logs. Prefer not storing tokens in `localStorage` (theme only).

## 8. Checklist command

`npm.cmd run remote:check` prints env **names** and presence — never secret values.

Mocked acceptance (no live tunnel): `npm.cmd run test:remote-acceptance`.
