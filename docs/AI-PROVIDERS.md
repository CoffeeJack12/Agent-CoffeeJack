# AI Providers

CoffeeJack treats inference as a **provider registry**, not a single hardcoded Ollama model.

## Local-first default

- **Ollama** is always registered and remains the default path.
- `qwen3:8b` is the configured local fallback when nothing else fits.
- The app works with **zero remote API keys**.

## ProviderRegistry

`server/providers/` exposes adapters with a shared interface:

| Method | Purpose |
| --- | --- |
| `listModels()` | Installed/configured models + known capabilities |
| `health()` | Bounded availability/latency (startup, config change, request, manual refresh) |
| `chat()` | Inference via `registry.chat({ providerId, modelId, ... })` |
| `supportsTools()` / `supportsVision()` / `supportsReasoning()` | Capability helpers |

Built-in providers:

| id | Type | Auth |
| --- | --- | --- |
| `ollama` | local | none |
| `openai` | remote | `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`) |
| `anthropic` | remote | `ANTHROPIC_API_KEY` |
| `google` | remote | `GOOGLE_API_KEY` / `GEMINI_API_KEY` |
| `openai-compatible` | remote | `OPENAI_COMPAT_API_KEY` + `OPENAI_COMPAT_BASE_URL` |

Raw API keys are **never** written to SQLite preferences, chats, memory, audit logs, or Git.

## Health & failure learning

Per provider/model (updated on real calls only):

- successes / failures / timeouts  
- last success / failure  
- rolling latency  
- bounded cooldown after repeated failures (not a permanent blacklist)  
- light quality boost after verified test outcomes  

## Smart Auto Model router

Returns `requestedModel` / `effectiveModel` / `provider` / `reasonCode` / `needsRemoteApproval` / `fallbackModels`.

Uses health/cooldown, Gaming Mode, Remote AI policy, and budget. Manual lock is hard for the **primary** execution model.

## AI Council

See [AI-COUNCIL.md](AI-COUNCIL.md). Council calls go through the same registry adapters with privacy sanitization and timeouts.

## Per-user policy

Isolated prefs: Remote AI, budget, Council mode/max/`councilOtherModels`. Settings UI shows Connected / Not configured / Unavailable — never full keys.
