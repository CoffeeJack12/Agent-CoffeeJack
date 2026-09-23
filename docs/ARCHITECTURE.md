# Architecture

CoffeeJack is a loopback-bound Node 24 application, with no frontend build step. The plain JavaScript/CSS frontend avoids a large development service running while the user games.

```text
Browser UI → loopback HTTP + streaming NDJSON → Jack agent loop
                                              ├─ Ollama models
                                              ├─ SQLite memory/history/events
                                              └─ Tool router
                                                 ├─ confined file tools
                                                 ├─ document readers
                                                 ├─ PowerShell / Git / package manager
                                                 ├─ isolated Playwright browser
                                                 └─ explicit Windows desktop adapter
```

## Modules

- `server/task-state.mjs`: user-grounded task context and pre-emission clarification/tone guard, persisted per chat.
- `server/planner.mjs`: bounded execution stages, tool evidence and one-repair test-claim evaluator.

- `server/index.mjs`: HTTP routing, session/Origin checks, uploads, approval lifecycle, cancellation, model routing and gaming process watcher.
- `server/access.mjs`: optional Cloudflare Access JWT boundary; disabled without full configuration. The listener stays on loopback.
- `server/router.mjs`: deterministic general/coding/vision selection with installed-model and capability checks.
- `server/memory.mjs`: ranked, bounded project context and credential-pattern rejection.
- `server/developer.mjs`: bounded project mapping, script detection and exact-context patching.
- `server/agent.mjs`: personality, conversation context, memory, model/tool loop and execution evidence.
- `server/ollama.mjs`: streaming model adapter, model listing and unloading.
- `server/store.mjs`: parameterized SQLite statements with WAL and foreign keys.
- `server/files.mjs`: realpath confinement and document extraction.
- `server/tools.mjs`: tool schemas and implementations; command cancellation kills the process tree on Windows.
- `scripts/desktop.ps1`: screenshot/mouse/keyboard operations invoked with structured base64 JSON, without command interpolation.
- `public/`: Arabic RTL frontend; untrusted model/tool strings are escaped before rendering.

## Data and lifecycle

`.local/coffeejack.sqlite` stores settings, messages, editable memories and tool events. `.local/projects` is the default generated-project workspace. `.local/backups` holds replaced-file backups. `.local/browser` stores the isolated browser session. `.local/artifacts` holds tool screenshots. Model/runtime binaries live in `.runtime`. None of these folders belongs in Git.

Only one agent task runs at a time. Mutating tools suspend until their exact operation is approved (or auto-approval is explicitly enabled). Approval expires after five minutes, and cancellation rejects pending approvals. Enabling gaming mode aborts the active task, waits for its cleanup, closes the automation browser and unloads all resident Ollama models. Configured process names are checked every 15 seconds. The next user request reloads its selected model after gaming mode ends.

## Extension points

Add tool schemas and implementations to `server/tools.mjs`, preserving approval and event recording. A new inference provider needs a compatible `chat`, `models`, `inspect` and `unload` adapter (with `prepare` for single-model residency); currently only Ollama is implemented. External API providers, MCP discovery, durable scheduled workflows, embeddings and fine-tuning are not implemented. Local shell/browser tools can access authorized services, but that is not a universal native integration.

## Tests

The automated suite covers persistence, traversal/junction escape prevention, blocked secret paths, model/tool error feedback, session/Origin checks, gaming-mode blocking, streaming messages and cancellation during approval. Hardware, real model, document, browser and desktop smoke tests are performed separately because they require Windows, installed models and interactive dependencies.

Optional remote architecture and provisioning prerequisites are documented in [REMOTE-ACCESS.md](REMOTE-ACCESS.md). Browser interaction checks run separately through `scripts/ui-smoke.mjs` and in the Windows browser CI job.
