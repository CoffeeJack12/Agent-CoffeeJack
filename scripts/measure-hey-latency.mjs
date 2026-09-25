/**
 * Warm end-to-end "hey" latency against local Ollama.
 * Usage: node scripts/measure-hey-latency.mjs
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { Ollama } from "../server/ollama.mjs";

const rounds = Number(process.env.HEY_ROUNDS || 3);

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-hey-lat-"));
  const ollama = new Ollama(process.env.OLLAMA_URL || "http://127.0.0.1:11434");
  // Warm 8b before measuring.
  try {
    await ollama.prepare("qwen3:8b", undefined, { soft: false });
    const warm = await ollama.chat({
      model: "qwen3:8b",
      messages: [{ role: "user", content: "ping" }],
      profile: { keepAlive: "10m", context: 2048, predict: 8, think: false },
      signal: AbortSignal.timeout(120000),
    });
    console.log("warmup_ok", Boolean(warm?.content), "chars", warm?.content?.length || 0);
  } catch (error) {
    console.error("warmup_failed", error.message);
    process.exitCode = 1;
    return;
  }

  process.env.COFFEEJACK_DEV_TIMING = "1";
  const app = await createApp({ dataDirectory: dir, ollama });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const results = [];

  for (let i = 0; i < rounds; i++) {
    const sendAt = performance.now();
    let firstUiTokenMs = null;
    let routing = null;
    let timing = null;
    const response = await fetch(base + "/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CoffeeJack-Token": app.token,
      },
      body: JSON.stringify({ text: "hey", requestedModel: "auto" }),
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const item = JSON.parse(line);
        if (item.type === "token" && firstUiTokenMs == null) {
          firstUiTokenMs = Math.round(performance.now() - sendAt);
        }
        if (item.type === "routing") routing = item;
        if (item.type === "timing") timing = item;
        if (item.type === "council") {
          console.error("UNEXPECTED_COUNCIL", item);
        }
      }
    }
    const row = {
      round: i + 1,
      first_ui_token_ms: firstUiTokenMs,
      model: routing?.model,
      fastPath: routing?.fastPath,
      ...timing,
    };
    results.push(row);
    console.log(JSON.stringify(row));
    // Small gap so keep_alive stays warm.
    await new Promise((r) => setTimeout(r, 250));
  }

  const tokens = results.map((r) => r.first_ui_token_ms).filter((n) => n != null);
  const avg = Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length);
  const min = Math.min(...tokens);
  console.log(
    JSON.stringify({
      summary: { rounds: tokens.length, min_first_ui_token_ms: min, avg_first_ui_token_ms: avg },
      model_already_loaded: results.map((r) => r.model_already_loaded),
    }),
  );

  await app.close();
  await fs.rm(dir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
