# CoffeeJack status

The app remains a local-first Windows agent with one active task at a time, local Ollama inference, SQLite persistence and an Arabic/English-capable RTL interface.

## Completed in this upgrade

- Execution reliability: stable anti-loop keys, fourth-failure blocking, successful-repeat reset, real Windows PowerShell and npm execution, protected recursive search and checked Git results.
- Routing: automatic general/coding classification, explicit modes, installed-model fallback, capability-verified vision and tool support. Image input overrides a non-vision selection. No model downloads are triggered by routing.
- Coding profile: reasoning enabled only when supported; 16K context on machines with at least 24 GB RAM, otherwise 8K, capped to declared model context. Coding output is bounded to 4096 tokens; normal chat retains the lightweight defaults. Other resident models are released before selecting one model. Gaming Mode still cancels tasks and unloads Ollama.
- Memory: project-scoped notes/lessons, global preferences, query ranking over saved memories, duplicate suppression, eight-entry/4000-character prompt budget, and rejection of common credential patterns. No background indexing or embeddings.
- Developer tools: unique exact-context `apply_patch` with backups, protected bounded `project_map`, detected npm scripts and approved `run_check` for build/lint/check. Existing targeted `run_tests` remains available. Oversized tool feedback stays valid JSON.
- UI: black/purple Jack identity, responsive composer, RTL, Markdown and copy controls, working startup/scroll function, streamed-error draft recovery, visible model routing and retained settings/approval controls. Chromium browser checks run in CI.
- Remote preparation: opt-in signed Cloudflare Access JWT verification for the remote hostname, while preserving local binding, session tokens and Origin validation. See [REMOTE-ACCESS.md](REMOTE-ACCESS.md). Nothing is published remotely by default.

## Verification and limits

The built-in Node suite and separate Chromium smoke cover persistence, workspace/secret/junction protections, real tool execution, model routing, ranked memory, HTTP security, approvals, gaming cancellation, and UI interactions. The CI workflow runs both on Windows. `node --test tests/*.test.mjs` runs core tests; `npm.cmd run test:ui` runs the browser smoke with Playwright Chromium installed.

Only `qwen3:8b` was present during development. Model intelligence is still a limiting factor; no stronger coding or vision model was downloaded. A missing vision model produces a clear error. Routing is deterministic keyword/capability logic, not a learned classifier. Memory is lexical ranking, not semantic retrieval, and credential detection is a heuristic rather than a general secret scanner.

Search is bounded to 50 results, 10,000 visited entries and 1 MB text files. Project maps are bounded to 200 entries and four directory levels. Patches require one unique exact text match, not arbitrary unified diffs. Complex changes remain constrained by the agent's 16-round budget and the selected model's capabilities.

The canonical Jack portrait was not present and has not been invented; the monogram is an intentional placeholder. No OCR, voice, remote model provider or recurring background agent was added. Browser/desktop actions and arbitrary shell commands retain their existing approval requirements and practical limitations.

Cloudflare provisioning and real remote end-to-end verification require account authorization/configuration. The application-side guard is tested locally; this is not a claim that a public tunnel is deployed.
