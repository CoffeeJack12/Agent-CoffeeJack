# AI Council

Bounded multi-model consultation through **ProviderRegistry**. Models propose text only; Jack remains the sole tool executor. No parallel uncontrolled terminal agents.

## Provider-native participants

Council membership is dynamic from configured, available models:

- Local Ollama models that are actually installed
- Remote OpenAI / Anthropic / Google / OpenAI-compatible models **only when keys are configured**

Never invents Claude/GPT/Gemini participants.

## Distinctness

- Prefer different **providers**, then different **models**
- Never present the same model ID as three independent AIs
- One suitable model → `1 model available — consultation skipped`

## Roles

Assigned intelligently when enough distinct models exist:

| Role | Typical use |
| --- | --- |
| PRIMARY | Strongest suitable model for the task |
| CRITIC | Different capable model |
| SPECIALIST | Optional domain/reasoning review |
| JUDGE | Optional when max ≥ 4 |

## Modes & settings (per user)

| Setting | Values | Default |
| --- | --- | --- |
| AI Council | Auto / On / Off | Auto |
| Max models | 2 / 3 / 4 | 2 |
| Remote AI | Allowed / Ask / Never | Allowed |
| Remote budget | Off / Conservative / Balanced / Performance | Conservative |
| Council may use other models | On / Off | On |

Manual model lock keeps **execution** on that model. Council may still consult others only if “Council may use other models” is On and privacy allows.

## Budget

- **Off**: local only
- **Conservative**: at most one remote participant
- **Balanced**: limited multi-provider remotes
- **Performance**: strongest suitable within max participants 

## Execution

```text
buildCouncilPlan → ProviderRegistry.chat per participant → normalize → synthesize
→ Jack executes tools → optional evidence round (max 2) → final answer
```

Timeouts: remote ~45s, local ~90s. Partial failures continue if ≥1 proposal succeeds.

## Privacy

Remote prompts are sanitized (`server/privacy.mjs`). Ask mode requires approval before first remote Council call. Guests stay local-only.

## Gaming Mode

Council is fully suppressed; no extra model loads or parallel provider calls.

## Verified lessons

Council agreement alone is **not** proof. Persistence still requires tests/sources/tool/user_statement evidence.
