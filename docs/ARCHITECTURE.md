# Architecture

CoffeeJack is a loopback-bound Node 24 application, with no frontend build step. The plain JavaScript/CSS frontend avoids a large development service running while the user games.

```text
Browser UI → loopback HTTP + streaming NDJSON → Jack agent loop
                                              ├─ ProviderRegistry (Ollama + optional remote)
                                              ├─ Smart Auto Model router + fallbacks
                                              ├─ Optional AI Council (text proposals)
                                              ├─ SQLite memory/history/events/lessons
                                              └─ Tool router (single executor)
                                                 ├─ confined file tools
                                                 ├─ document readers
                                                 ├─ PowerShell / Git / package manager
                                                 ├─ isolated Playwright browser
                                                 ├─ reverse engineering / security toolkit
                                                 └─ explicit Windows desktop adapter
```

## Modules

- `server/task-state.mjs`: user-grounded task context and pre-emission clarification/tone guard, persisted per chat.
- `server/planner.mjs`: bounded execution stages, tool evidence and one-repair test-claim evaluator.

- `server/index.mjs`: HTTP routing, database-backed session/Origin checks, per-user API scoping, uploads, approval lifecycle, cancellation, model routing and gaming process watcher.
- `server/users.mjs`: restart-safe multi-user migration, local profiles, sessions (expiry/source) and audit events.
- `server/identity.mjs`: Cloudflare Access ↔ CoffeeJack user mapping (`external_identities`); pending unmapped remote users.
- `server/workspaces.mjs`: per-user workspaces, memberships, chat binding, owner migration and path authorization helpers.
- `server/permissions.mjs`: owner/trusted/standard/guest role policy and per-capability allow, deny or approval decisions.
- `server/access.mjs`: optional Cloudflare Access JWT boundary; env validation diagnostics; returns verified identity attributes or false. The listener stays on loopback.
- `server/trust.mjs`: local vs remote classification — tunnel markers on loopback never become local owner; X-Forwarded-* is not trusted for locality.
- `server/router.mjs`: smart Auto Model selection via ProviderRegistry (with legacy Ollama-only path), reason codes, remote Ask approval flag and fallback model lists.
- `server/providers/`: ProviderRegistry and adapters (Ollama local; OpenAI / Anthropic / Google / OpenAI-compatible via env keys only).
- `server/council.mjs`: provider-native multi-model consultation (distinct participants, budgets, timeouts, partial failure, max 2 evidence rounds; Jack sole tool executor).
- `server/lessons.mjs`: verified lesson candidates with evidence gates and per-user scope.
- `server/privacy.mjs`: credential/session redaction before remote prompts.
- `server/providers/`: ProviderRegistry with adapter chat routing, model health/cooldown/quality signals (Ollama local; OpenAI / Anthropic / Google / OpenAI-compatible via env keys).
- `server/memory.mjs`: ranked, bounded project context and credential-pattern rejection.
- `server/developer.mjs`: bounded project mapping, script detection and exact-context patching.
- `server/agent.mjs`: personality, conversation context, memory, model/tool loop and execution evidence.
- `server/ollama.mjs`: streaming model adapter, model listing and unloading.
- `server/store.mjs`: parameterized SQLite statements with WAL and foreign keys.
- `server/files.mjs`: realpath confinement and document extraction.
- `server/tools.mjs`: tool schemas and implementations; command cancellation kills the process tree on Windows.
- `server/security/`: dedicated reverse-engineering toolkit — bounded PE parser, strings, hashing, optional Ghidra/Rizin/YARA adapters (detect-first, never auto-install), read-only process/network snapshots, Owner-approved metadata-only packet capture. Results use observed/derived/assessment/unverified labels. Host-level tools are Owner-direct for read-only inspection; Trusted needs explicit permission; Standard/Guest are denied. Packet capture is Owner-only and never auto-approved.
- `scripts/desktop.ps1`: screenshot/mouse/keyboard operations invoked with structured base64 JSON, without command interpolation.
- `public/`: Arabic RTL frontend; untrusted model/tool strings are escaped before rendering.

## Data and lifecycle

`.local/coffeejack.sqlite` stores users, sessions, external identities, workspaces, audit events, settings, messages, editable memories and tool events. Chats, memories, preferences, approvals, activity and workspaces are scoped to the authenticated session user. Legacy single-user data is assigned to the generated local owner during migration. The owner workspace points at the existing CoffeeJack/project path without moving it; other users get `.local/workspaces/<user-id>/`. `.local/backups` holds replaced-file backups. `.local/browser` stores the isolated browser session. `.local/artifacts` holds tool screenshots. `.local/security/` holds Ghidra analysis projects and per-user packet captures (`.local/security/captures/<user-id>/`). Model/runtime binaries live in `.runtime`. None of these folders belongs in Git.

Only one agent task runs at a time. Mutating tools suspend until their exact operation is approved (or auto-approval is explicitly enabled). Approval expires after five minutes, and cancellation rejects pending approvals. Enabling gaming mode aborts the active task, waits for its cleanup, closes the automation browser and unloads all resident Ollama models. Configured process names are checked every 15 seconds. The next user request reloads its selected model after gaming mode ends.

## Extension points

Add tool schemas and implementations to `server/tools.mjs`, preserving approval and event recording. New inference backends register as ProviderRegistry adapters (`listModels`, `health`, `chat`, capability helpers). Ollama remains the required local path; remote adapters are optional and keyless-by-default. External MCP discovery, durable scheduled workflows, embeddings and fine-tuning are not implemented. See [AI-PROVIDERS.md](AI-PROVIDERS.md) and [AI-COUNCIL.md](AI-COUNCIL.md).

## Tests

The automated suite covers persistence, traversal/junction escape prevention, blocked secret paths, model/tool error feedback, session/Origin checks, gaming-mode blocking, streaming messages and cancellation during approval. Hardware, real model, document, browser and desktop smoke tests are performed separately because they require Windows, installed models and interactive dependencies.

Optional remote architecture and provisioning prerequisites are documented in [REMOTE-ACCESS.md](REMOTE-ACCESS.md). Workspace isolation is documented in [WORKSPACES.md](WORKSPACES.md). Browser interaction checks run separately through `scripts/ui-smoke.mjs` and in the Windows browser CI job.
