/**
 * Streaming emit + latency helper regressions (no live Ollama required).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createTurnTiming, devTimingEnabled } from "../server/latency.mjs";
import { buildChatRequest } from "../server/ollama.mjs";

test("latency snapshot tracks named stages", () => {
  const timing = createTurnTiming();
  timing.mark("context_resolved");
  timing.mark("routing_done");
  timing.mark("context_done");
  timing.mark("prepare_start");
  timing.mark("model_ready");
  timing.mark("ollama_request_sent");
  timing.mark("first_token");
  timing.mark("generation_done");
  const snap = timing.snapshot({ model: "qwen3:8b" });
  assert.equal(typeof snap.routing_ms, "number");
  assert.equal(typeof snap.first_ui_token_ms, "number");
  assert.equal(typeof snap.first_token_ms, "number");
  assert.equal(typeof snap.total_ms, "number");
  assert.equal(snap.model, "qwen3:8b");
  assert.equal(devTimingEnabled(), process.env.COFFEEJACK_DEV_TIMING === "1");
});

test("ollama chat request always enables stream", () => {
  const body = buildChatRequest({
    model: "qwen3:8b",
    messages: [{ role: "user", content: "hi" }],
    profile: { keepAlive: "10m", context: 4096, predict: 1536 },
  });
  assert.equal(body.stream, true);
  assert.equal(body.keep_alive, "10m");
  assert.equal(body.options.num_ctx, 4096);
});
