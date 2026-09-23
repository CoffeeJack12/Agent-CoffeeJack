# Jarvis core progress

Baseline: `e6c4952`. This roadmap extends the existing architecture rather than replacing it.

## Conversation state

`server/task-state.mjs` accumulates user-grounded facts and evidence, unresolved slots, entity references, asked/answered questions, task transitions and bounded statements. SQLite `task_states` keeps one versioned state per conversation, with deletion cascading with the conversation. It is distinct from long-term memory and raw message history.

The agent includes bounded structured state in its prompt and validates a complete candidate response before emitting it. This deliberately buffers each model response so a repeated clarification cannot already have leaked through streaming tokens. Tool progress still streams. The repetition guard uses semantic slot categories and normalized lexical similarity; it is not a general semantic model and cannot guarantee every possible paraphrase is recognized. Device ownership/location is distinct from authorization for third-party actions.

Entity extraction currently covers project/file names, game targets and distribution, local-device context, goals and single-slot clarification answers. Explicit new-task/topic-switch, correction and cancellation markers are tracked. More general task interpretation remains model-dependent.

## Validation so far

43 Node tests pass and Chromium smoke passes. The exact three-turn Steam conversation was run against local `qwen3:8b`: first response asked target/result, second asked game name/objective, third asked the game name. No repeated machine/lab/external question appeared after the device fact. Observed turn latency was 1045/841/1053 ms on this run; these are individual warm-system observations, not a statistical benchmark.

## Next implementation priorities

1. Structured resumable planner, evidence-based final evaluation, persisted tool/approval state.
2. Safe multi-user migration, isolated data/sessions/permissions and verified lesson evidence.
3. Provider registry and bounded consultation without requiring remote keys.
4. Research sources, voice foundation, scheduler and gaming integration.

The running app may still be on the previous loaded code until restarted. Test instances use isolated temporary databases. Do not remove original security or Gaming Mode tests.
