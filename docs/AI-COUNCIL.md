# AI Council

Bounded multi-model consultation. Models **propose text only**; Jack remains the sole tool executor. No parallel uncontrolled terminal agents.

## Modes (per user)

| Mode | Behavior |
| --- | --- |
| **Auto** (default) | Consult when complexity/explicit request warrants it |
| **On** | Prefer consultation for meaningful complex work |
| **Off** | Single-model only |

## When it runs

Triggers include: explicit “ask the council / second opinion”, complex architecture/debugging/research synthesis, repeated failed approaches.

Skipped for: greetings, simple Q&A, basic edits, Empathy (unless explicit), Gaming Mode, or fewer than two suitable models.

## Budget

- Council max models: 2 / 3 / 4
- Remote budget policy controls how eagerly remote participants are preferred
- With only local models, council still works if ≥2 suitable locals exist

## No fake council

If only `qwen3:8b` is available, CoffeeJack reports **1 model available — consultation skipped**. It never invents Claude/GPT participants.

## Flow

1. Orchestrator decides consultation is useful  
2. Select ≤ N participants (roles: primary / critic / specialist)  
3. Collect proposals  
4. Normalize + synthesize for the agent system prompt  
5. Jack executes tools once, with evidence  
6. Optionally store a **verified** lesson (see below)

UI shows Council status and participant roles/status — not hidden chain-of-thought.

## Verified lessons

`server/lessons.mjs` persists durable technical lessons only with verification:

| Type | Evidence |
| --- | --- |
| `tests` | Test/tool pass evidence |
| `sources` | URL-backed research |
| `tool` | Tool evidence |
| `user_statement` | Workflow preference stated by the user |

Council agreement alone is not proof. Secrets are rejected. Scopes: **private** (user), **project**, never promote personal prefs to SYSTEM.
