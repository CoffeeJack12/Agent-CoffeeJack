# Optional Cloudflare remote access

Status: the application-side authentication boundary is implemented and tested. No tunnel, DNS record, Access application or public endpoint has been provisioned. Remote access is disabled when the four configuration values below are absent. The Node listener remains bound to `127.0.0.1` even when remote access is configured.

## Architecture

```text
Authorized browser → Cloudflare Access (identity + MFA policy)
                   → authenticated Cloudflare Tunnel
                   → loopback CoffeeJack HTTP server on Windows
                   → local Ollama, SQLite, files and approved tools

GitHub → source history, review, CI and backup
```

GitHub and the Windows runtime retain their current roles. No agent runtime moves to Workers. Ollama port 11434 is never a tunnel destination. There are no router port forwards or listeners on `0.0.0.0`.

## Configuration contract

Set these process environment values only after provisioning an Access application for the exact hostname:

| Value                      | Purpose                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `COFFEEJACK_REMOTE_HOST`   | Exact lowercase public hostname, without scheme, port or path |
| `CF_ACCESS_TEAM_DOMAIN`    | The account's `team-name.cloudflareaccess.com` domain         |
| `CF_ACCESS_AUD`            | The Access application's 64-character audience tag            |
| `CF_ACCESS_ALLOWED_EMAILS` | Comma-separated explicitly authorized email identities        |

Partial or invalid configuration prevents startup. The application validates RS256 signatures using the configured team's HTTPS key endpoint, then verifies issuer, audience, expiry, not-before and the email allowlist. Signing keys are fetched on demand and cached for one minute. No background polling or model loading is added. Failed validation or unavailable signing keys deny access.

Every request to the remote hostname, including HTML and read-only APIs, requires `Cf-Access-Jwt-Assertion`. An arbitrary identity header does not grant access. Existing session-token checks still apply to mutations. The remote browser Origin must be exactly `https://<configured-hostname>`, and cross-site requests remain blocked. Local host and HTTP Origin rules remain unchanged.

## Provisioning checklist for the operator/agent

1. Create an Access self-hosted application for the entire hostname (all paths), with an allow policy restricted to the owner's email and the chosen identity provider; enable MFA. Do not use Bypass or Everyone policies.
2. Create a remotely managed Tunnel and a public hostname service targeting `http://127.0.0.1:3210`. Keep the Host header equal to `COFFEEJACK_REMOTE_HOST`; do not rewrite it to localhost, which would prevent remote Origin validation.
3. Enable Tunnel **Protect with Access** using the same team and application audience, adding connector-side JWT validation as another boundary.
4. Configure the four non-secret application values and restart CoffeeJack. Keep tool auto-approval disabled for remote use.
5. Install `cloudflared` and run the connector with a restricted local token file using `--token-file`. Keep that file outside the repository, restrict it to the owning Windows account, and never print its contents. Do not put tokens on a command line, in logs or in Git.
6. Verify unauthenticated and unauthorized browsers cannot retrieve `/`, `/api/status`, chat history, artifacts or files. Verify the authorized browser can stream chat and approve a bounded test action. Verify cross-origin requests and missing session tokens are rejected. Check Gaming Mode cancels active work from the remote browser.
7. Document the tunnel ID and chosen hostname, without credentials. Stopping the connector removes remote reachability; local CoffeeJack keeps working.

The unit/HTTP tests exercise valid signed tokens, tampered signatures, expiry, future validity, incorrect issuer/audience/email, unavailable keys, protected reads, and the existing token/origin boundaries. They do not replace the final real Cloudflare end-to-end checks.

## Credential-dependent next step

To provision the resources directly, the operator/agent needs a narrowly scoped Cloudflare API token with Tunnel write, Access applications/policies edit and DNS edit for the intended account/zone, together with account ID, zone ID, chosen hostname and allowed login email. An existing authenticated Cloudflare session may be used instead. If resources already exist, supply their non-secret configuration plus the Tunnel connector token through a secure local secret file. No Cloudflare credentials are currently installed by this project.

References: [Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/), [Tunnel origin Access validation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/), [Tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/), [token-file option](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/).
