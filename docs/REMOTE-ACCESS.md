# Optional Cloudflare remote access

Status: application-side Access JWT verification, identity mapping, remote session issuance and workspace isolation are implemented and tested. Tunnel/DNS/Access app provisioning remain operator steps. Remote access is disabled when the four configuration values below are absent. The Node listener remains bound to `127.0.0.1` even when remote access is configured.

## Trust boundary

```text
LOCAL  127.0.0.1 / localhost
       → owner bootstrap allowed; CF headers ignored

REMOTE configured hostname
       → Cloudflare Access JWT required
       → map verified subject/email → CoffeeJack user
       → issue CoffeeJack session (source=remote)
       → never fall back to owner for unmapped identities
```

## Architecture

```text
Authorized browser → Cloudflare Access (identity + MFA policy)
                   → authenticated Cloudflare Tunnel
                   → loopback CoffeeJack HTTP server on Windows
                   → identity map → session → per-user workspace tools
                   → local Ollama, SQLite, files and approved tools
```

## Configuration

| Value                         | Purpose                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `COFFEEJACK_REMOTE_HOST`      | Exact lowercase public hostname, without scheme, port or path |
| `CF_ACCESS_TEAM_DOMAIN`       | `team-name.cloudflareaccess.com`                              |
| `CF_ACCESS_AUD`               | Access application audience (64 hex chars)                    |
| `CF_ACCESS_ALLOWED_EMAILS`    | Comma-separated Access allowlist (signature gate)             |
| `CF_ACCESS_OWNER_EMAIL`       | Optional; first verified email that may auto-link to owner    |
| `CF_ACCESS_AUTO_CREATE_ROLE`  | Optional `standard` to auto-create users; default is pending  |

Partial or invalid configuration prevents startup. The application validates RS256 signatures, issuer, audience, expiry, nbf and the email allowlist. Authorize returns verified `{ email, subject, issuer, audience }` or `false`.

## Identity mapping

After JWT verification, CoffeeJack looks up `external_identities` by provider + subject. Email assist may auto-link only when `CF_ACCESS_OWNER_EMAIL` (or explicit owner link API) matches. Unknown verified users receive HTTP 403 `pending_identity` and see an access-pending UI — no chats, memories or workspaces.

Sessions expire (remote ~24h, local ~7d), reject disabled users, and are revoked on logout or when a remote mapping no longer matches. Profile switching is refused on remote hosts.

## Remote restrictions

Cloudflare identity alone does **not** grant desktop control, Gaming toggle, or owner workspace access. Existing capability permissions and per-user workspaces still apply. Guests/standard users stay in their own roots under `.local/workspaces/<id>/`.

## Provisioning checklist

1. Access application for the hostname with MFA and an allow policy for known emails.
2. Tunnel public hostname → `http://127.0.0.1:3210` with Host preserved as `COFFEEJACK_REMOTE_HOST`.
3. Set env values; optionally set `CF_ACCESS_OWNER_EMAIL` so the first remote owner login links without a duplicate account.
4. Verify unauthenticated/unauthorized browsers cannot read app data; verify pending users see access-pending; verify mapped users get their own workspace only.

## Limits

Tests cover mocked JWTs (mapped owner, unknown, expired, wrong aud/iss, disabled user, mapping removed, remote switch deny, spoofed loopback headers). They do not replace live Cloudflare tunnel verification.
