# CoffeeJack status

The app remains a local-first Windows agent with one active task at a time, local Ollama inference (plus optional remote providers via env keys), SQLite persistence and an Arabic/English-capable RTL interface.

## Completed in this upgrade

- Multi-user profiles: database-backed sessions, owner/trusted/standard/guest roles, scoped chats/memory/preferences/activity/approvals, owner user management and local-only profile switching, audit events, and transactional legacy-data backfill. See [MULTI-USER.md](MULTI-USER.md).
- Cloudflare identity mapping: verified Access JWT → `external_identities` → CoffeeJack user; pending unmapped remotes; no owner fallback; tunnel-aware trust boundary (loopback+CF markers ≠ local owner); hardened session expiry/revocation; remote readiness check (`npm.cmd run remote:check`). See [REMOTE-ACCESS.md](REMOTE-ACCESS.md) and [CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md).
- Per-user workspaces: owner CoffeeJack path preserved; other users under `.local/workspaces/<id>/`; chat→workspace binding; tools/git/shell scoped with realpath confinement. See [WORKSPACES.md](WORKSPACES.md).
- AI Provider Registry: Ollama + optional OpenAI/Anthropic/Google/OpenAI-compatible adapters, model capability catalog, smart Auto Model router with reason codes, health/cooldown, fallback chains, Remote AI Allowed/Ask/Never, per-user council/budget/`councilOtherModels` prefs, privacy sanitizer. Works with zero remote keys; `qwen3:8b` remains local fallback. See [AI-PROVIDERS.md](AI-PROVIDERS.md).
- AI Council: **provider-native** multi-model consultation with automatic bounded **evidence Round 2** after meaningful tool verification (tests/sources/inspection). Research evidence prefers structured tool payloads (slim stored sources) over scraping chat text. Distinct providers/models, no fakes, Gaming suppresses, Jack sole tool executor, timeouts/partial failure, max 2 rounds. Tool evidence overrides council majority. See [AI-COUNCIL.md](AI-COUNCIL.md).
- Jarvis foundation: persisted conversation facts/questions, Steam continuity, direct cybersecurity tone, existing-chat bootstrap, execution plans and bounded test-claim evaluation. See [JARVIS-CORE.md](JARVIS-CORE.md) for supported cases and limits.
- Adaptive Security Validation Lab: Owner-only authorized-target registry, bounded adaptive HTTP/network tests, target-scoped lessons, policy-gap reports, optional telemetry adapters, and an Owner-only Security Lab page. Standard/Guest are denied. Trusted access requires explicit Owner permission and cannot manage targets.

- Execution reliability: stable anti-loop keys, fourth-failure blocking, successful-repeat reset, real Windows PowerShell and npm execution, protected recursive search and checked Git results.
- Routing: automatic general/coding classification, explicit modes, installed-model fallback, capability-verified vision and tool support. Image input overrides a non-vision selection. No model downloads are triggered by routing.
- Coding profile: reasoning enabled only when supported; 16K context on machines with at least 24 GB RAM, otherwise 8K, capped to declared model context. Coding output is bounded to 4096 tokens; normal chat retains the lightweight defaults. Other resident models are released before selecting one model. Gaming Mode still cancels tasks and unloads Ollama.
- Memory: project-scoped notes/lessons, global preferences, query ranking over saved memories, duplicate suppression, eight-entry/4000-character prompt budget, and rejection of common credential patterns. No background indexing or embeddings.
- Developer tools: unique exact-context `apply_patch` with backups, protected bounded `project_map`, detected npm scripts and approved `run_check` for build/lint/check. Existing targeted `run_tests` remains available. Oversized tool feedback stays valid JSON.
- UI: black/purple Jack identity, responsive composer, RTL, Markdown and copy controls, working startup/scroll function, streamed-error draft recovery, visible model routing (Auto → effective model), provider status, Council events and retained settings/approval controls. Chromium browser checks run in CI.
- Remote preparation: opt-in signed Cloudflare Access JWT verification for the remote hostname, while preserving local binding, session tokens and Origin validation. See [REMOTE-ACCESS.md](REMOTE-ACCESS.md). Nothing is published remotely by default.

## Verification and limits

The built-in Node suite and separate Chromium smoke cover persistence, multi-user migration and isolation, role permissions, workspace/secret/junction protections, real tool execution, model routing, provider registry/council/lessons, ranked memory, HTTP security, approvals, gaming cancellation, and UI interactions. The CI workflow runs both on Windows. `node --test tests/*.test.mjs` runs core tests; `npm.cmd run test:ui` runs the browser smoke with Playwright Chromium installed.

Only `qwen3:8b` was present during development. Remote providers are implemented but live remote calls remain pending until API keys exist in the environment. Model intelligence is still a limiting factor; no stronger coding or vision model was downloaded. A missing vision model produces a clear error. Routing is deterministic keyword/capability logic, not a learned classifier. Memory is lexical ranking, not semantic retrieval, and credential detection is a heuristic rather than a general secret scanner.

Search is bounded to 50 results, 10,000 visited entries and 1 MB text files. Project maps are bounded to 200 entries and four directory levels. Patches require one unique exact text match, not arbitrary unified diffs. Complex changes remain constrained by the agent's 16-round budget and the selected model's capabilities.

The canonical Jack portrait was not present and has not been invented; the monogram is an intentional placeholder. No OCR, voice, or recurring background agent was added. Browser/desktop actions and arbitrary shell commands retain their existing approval requirements and practical limitations.

Cloudflare Tunnel/Access operator setup is documented in [CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md). Live tunnel verification requires account credentials and is not claimed by CI.
