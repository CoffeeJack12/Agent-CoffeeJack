# CoffeeJack engineering handover — 23 September 2026

Repository: `C:\Users\Abdul\Documents\Codex\2026-09-19\coffeejack-github-x20`.
Remote: https://github.com/CoffeeJack12/Agent-CoffeeJack, branch `main`.
Read `git status --short` and `git log -3 --oneline` before further work. This document accompanies the planner foundation commit; use Git for its exact hash.

## Delivered

- Previous baseline `e6c4952`: execution tools, routing, lexical memory, UI/browser CI and optional Cloudflare Access guard.
- `f0433b4`: persisted task facts, entities, questions, transitions and repetition guard.
- `fd68d34`: direct cybersecurity/reverse-engineering tone; no generic ethical/legal-boundaries or unlimited-help language; retained local-device/Steam context; existing-chat upgrade bootstrap. CI run `35851572040` completed successfully, as did the state foundation run `35851179564`.
- This commit: bounded coding execution plans, persisted tool evidence/failures, cancellation before inference, one-repair tests-passed claim evaluator, workspace isolation for evidence, and Windows npm wrapper discovery fix.

## Verification

53 Node tests passed through `npm.cmd test`. Browser regression passed through `npm.cmd run test:ui`: desktop/tablet/mobile, RTL, keyboard, Markdown, clipboard, draft recovery after streaming errors, approvals, models, Gaming Mode and theme. Syntax checks and Git whitespace checks passed. Verify this commit's GitHub Actions status separately; do not infer it from the previous green runs.

Real installed `qwen3:8b` acceptance:

- Exact game → own device → Steam conversation passed. Final reply asked game name and objective, without restarting machine/lab/external questions or boilerplate. Tone-fix observations: 4409/865/934 ms for the three turns.
- Isolated coding project passed: read `add.cjs`, changed subtraction to addition using `apply_patch`, ran original tests without changing them. Three successful tools, zero failures, approximately 25 seconds. Repeated after the planner integration.
- Project-pronoun resolution, bounded repair, cancellation, persistence and false-success interception have automated behavioral tests. Multi-user and current-web acceptance remain outstanding because those roadmap features are not implemented.

## Runtime and performance observations

Local app restarted with tested code; PID observed `28752`, loopback port 3210, below-normal process priority. Check process identity and `/api/status` busy flag before any restart. Never print the status response's session token.

One restart/idle observation: readiness 612 ms, working set 53.1 MiB, 0 CPU seconds accumulated over a five-second idle sample. Ollama reported no loaded models after live tests. SQLite files including WAL/SHM totaled approximately 1.29 MB. These are single observations, not statistical benchmarks. Loaded model RAM/VRAM and sustained Gaming Mode performance still need measurement.

Original data remains in `.local`; do not replace its database with test fixtures. App logs: `.local/logs/app-out.log` and `app-error.log`. Tests use isolated temporary databases/projects. No giant models, remote credentials or public tunnel were added.

## Limits and next work

The roadmap is NOT complete. State extraction and repetition matching use semantic slots/lexical heuristics, not a universal conversation interpreter. Model responses are buffered per round before emission; tool progress streams. The planner records observed categories, not proof a goal is solved. Its evaluator handles a narrow class of English/Arabic test-success claims and requires unfiltered `run_tests` exit zero after the latest edit or shell action. It is not a general truth verifier. No secrets or raw tool arguments are copied into execution evidence.

Exact next priority: complete the planner's approval lifecycle and recovery semantics, custom validated steps and broader evidence-based completion checks; then implement multi-user authentication and isolated storage with migration tests preserving the current owner's data. Avoid trusting a client-supplied profile ID. Current app still has one owner, one active job, global tools/settings/workspace and a single database.

Remaining phases: user/session/permission isolation; provider registry and bounded AI consultation; verified lessons; sourced research; local-first voice abstraction; gaming-aware scheduler; final integration and performance benchmarks. Optional remote keys are unavailable but do not block these foundations. No credential is currently required for the next phase.

Useful code: `server/task-state.mjs`, `planner.mjs`, `agent.mjs`, `store.mjs`, `index.mjs`; corresponding tests in `tests/task-state.test.mjs` and `tests/planner.test.mjs`. See `docs/JARVIS-CORE.md`, `STATUS.md`, and `ARCHITECTURE.md`.

PowerShell workflow: use `npm.cmd`, do not change execution policy, preserve user work, run full tests/browser/syntax/diff checks before commit/push, then verify both GitHub Actions jobs. Repo writes in Documents require the tool's escalation mode in the current desktop sandbox. User has explicitly authorized autonomous implementation, commit and push.
