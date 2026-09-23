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
| `chat()` / stream via chat | Inference |
| `supportsTools()` / `supportsVision()` / `supportsReasoning()` | Capability helpers |

Built-in providers:

| id | Type | Auth |
| --- | --- | --- |
| `ollama` | local | none |
| `openai` | remote | `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`) |
| `anthropic` | remote | `ANTHROPIC_API_KEY` |
| `google` | remote | `GOOGLE_API_KEY` |
| `openai-compatible` | remote | `OPENAI_COMPAT_API_KEY` + `OPENAI_COMPAT_BASE_URL` |

Raw API keys are **never** written to SQLite preferences, chats, memory, audit logs, or Git. Adapters read environment variables only.

## Model capability registry

Models carry known flags only (tools, vision, reasoning/thinking, coding hints, context length, local/remote, cost/speed tiers). Ollama metadata is inspected when available. Remote catalogs appear only when that provider is configured.

## Smart Auto Model router

`server/router.mjs` returns:

- `requestedModel` / `effectiveModel`
- `provider`
- `reasonCode` (`local_fast`, `coding_capable`, `vision_required`, `reasoning_required`, `gaming_fallback`, `manual_lock`, `provider_unavailable`, `fallback_after_failure`, …)
- `needsRemoteApproval` when Remote AI = Ask
- `fallbackModels` for post-failure retries

Routing inputs include task kind, mode, Gaming Mode, CapabilityRegistry-aligned needs, provider health, previous failures, and per-user privacy/budget prefs. Manual model selection is a hard lock.

## Fallback chain

On real failure: skip identical retries → next suitable configured model → local coding-capable → `qwen3:8b`. Evidence is emitted; success of the first model is never claimed after a fallback.

## Per-user provider policy

Preferences (isolated per user):

- **Remote AI**: Allowed / Ask / Never (guest forced to Never)
- **Remote AI budget**: Off / Conservative / Balanced / Performance (policy only; no billing)
- **AI Council** / max models — see [AI-COUNCIL.md](AI-COUNCIL.md)

Settings → AI Providers shows Connected / Not configured / Unavailable without exposing secrets.

## Privacy

Before remote calls, `server/privacy.mjs` strips credentials/session material and truncates oversized context. Never send tool credentials in prompts.
