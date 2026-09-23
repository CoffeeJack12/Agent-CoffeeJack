# Multi-user profiles

CoffeeJack supports local profiles backed by SQLite. On first upgrade, it creates an active owner and assigns all legacy chats, memories, events and owner preferences to that profile. The migration is transactional and safe to run again.

## Identity and isolation

Identity comes only from `X-CoffeeJack-Token`. Request bodies and query strings never select the acting user. Loopback `GET /api/status` bootstraps an owner session when no valid token exists; other API routes require a valid active session.

Chats, memories, preferences, activity, memory proposals and approvals are filtered by the session user. Switching profiles returns a new token; the client must use that token before the target identity applies.

## Roles

- `owner`: manages users and gaming mode; normal sensitive tool rules still apply.
- `trusted`: broad tool access, but no user management or sensitive settings.
- `standard`: chat, research and read access; selected writes and commands require approval.
- `guest`: chat and research; file reads require approval and powerful actions are denied.

Permission decisions are `allow`, `deny`, or `require_approval`. Tool execution remains observable and cancellable. Approval requests can only be answered by the user who owns the active run.

## User API

- `GET /api/users`: owners see all profiles; other roles see themselves.
- `POST /api/users`: owner-only profile creation.
- `PATCH /api/users/:id`: owner-only rename, role or status update. The last active owner cannot be demoted or disabled.
- `POST /api/session/switch`: owner-only switch to an active profile; returns a new session token.

User creation, profile changes, profile switches, approval decisions and manual gaming changes are written to `audit_events`. Audit details redact likely secrets and message content.

## Current limits

Profiles share the configured workspace, model installation, global runtime settings, browser storage and the single active agent slot. This is local profile separation, not OS-level sandboxing or a network multi-tenant security boundary. There is no password login, session management screen, per-user workspace, encrypted database, or remote user provisioning.
