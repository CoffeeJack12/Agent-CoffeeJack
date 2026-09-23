# Multi-user profiles

CoffeeJack supports local profiles backed by SQLite. On first upgrade, it creates an active owner and assigns all legacy chats, memories, events and owner preferences to that profile. The migration is transactional and safe to run again.

## Identity and isolation

Identity comes only from `X-CoffeeJack-Token` (and, for remote hosts, a verified Cloudflare Access JWT mapped to a CoffeeJack user). Request bodies and query strings never select the acting user.

- **Local (127.0.0.1 / localhost):** `GET /api/status` bootstraps an owner session when no valid token exists. Profile switching remains owner-only and local-only.
- **Remote (configured Cloudflare host):** Access JWT is verified server-side. Verified `email` + `sub` map through `external_identities` to a CoffeeJack user. Unmapped identities get `pending_identity` (no owner fallback). Spoofed CF headers on loopback are ignored.

Chats, memories, preferences, activity, memory proposals, approvals and workspaces are filtered by the session user. Switching profiles returns a new token; the client must use that token before the target identity applies.

## External identities

Table `external_identities` stores `provider` (e.g. `cloudflare_access`), `external_subject`, optional `normalized_email`, and `user_id`. Subject is the primary key for mapping. Owner auto-link uses explicit env allowlists (`CF_ACCESS_OWNER_EMAIL` / first allowed email), never silent email guessing. Optional `CF_ACCESS_AUTO_CREATE_ROLE=standard` can auto-create standard users; default is pending until the owner links or creates them.

## Roles

- `owner`: manages users and gaming mode; normal sensitive tool rules still apply.
- `trusted`: broad tool access, but no user management or sensitive settings.
- `standard`: chat, research and read access; selected writes and commands require approval.
- `guest`: chat and research; file reads require approval and powerful actions are denied.

Permission decisions are `allow`, `deny`, or `require_approval`. Tool execution remains observable and cancellable. Approval requests can only be answered by the user who owns the active run.

## Workspaces

Each user has a private default workspace. The owner’s CoffeeJack repo path is preserved as a logical workspace record. See [WORKSPACES.md](WORKSPACES.md).

## User API

- `GET /api/users`: owners see all profiles (with identity link status); other roles see themselves.
- `POST /api/users`: owner-only profile creation (also creates a private workspace).
- `PATCH /api/users/:id`: owner-only rename, role or status update. The last active owner cannot be demoted or disabled.
- `POST /api/session/switch`: **local** owner-only switch to an active profile; returns a new session token.
- `POST /api/session/logout`: revokes the current session.
- `POST /api/identity/link`: owner links a verified external subject/email to a user.
- `GET /api/workspaces`, `POST /api/workspaces/active`: list/select accessible workspaces.

User creation, profile changes, identity link/unlink, remote login/deny, workspace create/switch/deny, approval decisions and manual gaming changes are written to `audit_events`. Audit details redact likely secrets and message content.

## Session token transport

- **Local:** `X-CoffeeJack-Token` from `/api/status`, held in memory by the UI (not `localStorage`).
- **Remote:** same header for compatibility, plus `Set-Cookie: coffeejack_session` (HttpOnly, Secure, SameSite=Lax).
- Audit events redact token/secret fields. Do not log Authorization or cookie values.
- `/artifacts/*` requires a valid session. `/api/stop` only cancels the caller's own active task.
- `OLLAMA_URL` must be loopback unless `COFFEEJACK_ALLOW_REMOTE_OLLAMA=1` (owned lab only).

## Current limits

Profiles share the machine, model installation and the single active agent slot. Isolation is SQLite + workspace path policy, not OS multi-tenancy. There is no password login UI beyond Cloudflare Access for remote; local remains frictionless for the owner. Artifact files are session-gated but not yet per-user path partitioned.
