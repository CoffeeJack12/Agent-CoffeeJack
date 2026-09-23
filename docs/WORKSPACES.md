# Workspaces

CoffeeJack scopes filesystem and developer tools to per-user workspaces. Identity comes from the server session; clients never authorize by path or `userId` alone.

## Model

- `workspaces`: id, owner_user_id, name, root_path, status, timestamps
- `workspace_memberships`: workspace_id, user_id, role
- `chats.workspace_id`: active workspace for that chat; tasks inherit it

Private per-user workspaces are the default. Membership exists so sharing can be added later without redesign.

## Owner migration

On startup, the local owner gets an idempotent **CoffeeJack** workspace whose `root_path` is the existing configured workspace (or the repo root). The physical folder is not moved or renamed. Legacy `settings.workspace` remains aligned with that owner path for compatibility.

## Other users

Non-owner users receive a private root under `.local/workspaces/<user-id>/`. They do not inherit the owner repository. Listing and selection APIs only return workspaces the caller can access.

## Authorization path

Before workspace-aware tools run:

1. Resolve session user
2. Resolve chat/active workspace
3. Verify membership
4. Confine requested paths with realpath/symlink/junction checks inside that root
5. Apply the existing permission engine (`files_read`, `files_write`, `git_*`, `terminal_*`, …)

Workspace ownership does not bypass role policy. Guests still cannot write freely; Gaming and desktop control remain capability-gated.

## Tools and Git

`read_file`, `write_file`, `apply_patch`, `search_code`, `project_map`, `run_tests`, `git_status`, `git_diff`, and shell/dev commands use the active workspace root as `cwd` / confinement base. Absolute paths and `..` escapes are rejected. Commands that look outside the workspace trigger deny or require_approval via `outside_workspace`.

## Local profile switch

Switching profiles (local owner-only) clears client chat/workspace UI state and issues a new session token. Remote clients cannot call profile switch to impersonate another user. Tunnel Host must remain the public hostname; Cloudflare markers on loopback are treated as remote (never local-owner bootstrap). See [CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md).

## Limits

This is application-level isolation on one Windows machine, not OS sandboxing or multi-tenant hosting. PowerShell is not a full sandbox; policy + cwd + path checks are the boundary. Full local paths may appear in owner-facing settings; restricted users should not receive other users’ workspace roots.
