/**
 * Live Jeddawi direct-path verification (renderer = fallback only).
 */
const status = await fetch("http://127.0.0.1:3210/api/status").then((r) =>
  r.json(),
);
const headers = {
  "Content-Type": "application/json",
  "X-CoffeeJack-Token": status.token,
};
if (status.gaming) {
  await fetch("http://127.0.0.1:3210/api/gaming", {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: false }),
  });
}

async function chat(text, chatId) {
  const t0 = performance.now();
  const res = await fetch("http://127.0.0.1:3210/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ text, chatId, requestedModel: "auto" }),
  });
  const raw = await res.text();
  const totalMsClient = Math.round(performance.now() - t0);
  let reply = "";
  let ctx = null;
  let routing = null;
  let render = null;
  let guard = null;
  let done = null;
  let timing = null;
  let next = chatId;
  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "chat") next = ev.chat?.id || next;
    if (ev.type === "turn_context") ctx = ev;
    if (ev.type === "routing") routing = ev;
    if (ev.type === "jeddawi_render") render = ev;
    if (ev.type === "jeddawi_guard") guard = ev;
    if (ev.type === "done") done = ev;
    if (ev.type === "timing") timing = ev;
    if (ev.type === "token") reply += ev.text;
    if (ev.type === "revise") reply = ev.text == null ? reply : ev.text;
  }
  const rendererUsed = Boolean(
    done?.renderer_used ?? render?.renderer_used ?? false,
  );
  return {
    chatId: next,
    reply: reply.trim(),
    ctx,
    model: done?.core_model || routing?.effectiveModel || routing?.model,
    rendererUsed,
    directPass: done?.jeddawi_direct_pass ?? guard?.pass ?? null,
    fallbackReason: done?.jeddawi_fallback_reason || render?.reason || null,
    firstTokenMs: timing?.first_token_ms ?? null,
    coreGenerationMs: timing?.core_generation_ms ?? null,
    guardMs: timing?.jeddawi_guard_ms ?? null,
    rendererMs:
      timing?.renderer_ms ??
      timing?.jeddawi_render_ms ??
      render?.render_ms ??
      null,
    totalMs: timing?.total_ms ?? totalMsClient,
    modelAlreadyLoaded: timing?.model_already_loaded ?? null,
    modelLoadMs: timing?.model_load_ms ?? null,
  };
}

const turns = [
  "من دحين كلمني جداوي طبيعي.",
  "ايش رايك اروح النادي دحين ولا بعد العشا؟",
  "يا حبيبي اديني الزبدة",
  "English now",
  "what if I can't go today?",
  "ارجع جداوي",
  "طيب لو ما زبط؟",
  "لا تفلسفها",
  "دحين ايش اسوي؟",
  "مين سيدك؟",
];

let chatId;
const transcript = [];
let jeddawiTotals = [];

for (let i = 0; i < turns.length; i++) {
  const text = turns[i];
  const r = await chat(text, chatId);
  chatId = r.chatId;
  const row = {
    turn: i + 1,
    user: text,
    intent: r.ctx?.intent,
    style: r.ctx?.conversationStyle,
    model: r.model,
    model_already_loaded: r.modelAlreadyLoaded,
    model_load_ms: r.modelLoadMs,
    renderer_used: r.rendererUsed,
    direct_pass: r.directPass,
    fallback_reason: r.fallbackReason,
    first_token_ms: r.firstTokenMs,
    core_generation_ms: r.coreGenerationMs,
    guard_ms: r.guardMs,
    renderer_ms: r.rendererMs,
    total_ms: r.totalMs,
    reply: r.reply,
  };
  transcript.push(row);
  if (row.style?.arabic_style === "jeddawi" && row.style?.language !== "en") {
    jeddawiTotals.push(row.total_ms);
  }
  console.log("\n=== TURN", row.turn);
  console.log("USER:", text);
  console.log(
    JSON.stringify(
      {
        model: row.model,
        model_already_loaded: row.model_already_loaded,
        model_load_ms: row.model_load_ms,
        renderer_used: row.renderer_used,
        first_token_ms: row.first_token_ms,
        core_generation_ms: row.core_generation_ms,
        guard_ms: row.guard_ms,
        renderer_ms: row.renderer_ms,
        total_ms: row.total_ms,
        reply: row.reply,
      },
      null,
      2,
    ),
  );
}

// Technical preservation on same chat
const tech = await chat(
  "قول لي بشكل جداوي:\nThe file is C:\\Users\\Abdul\\CoffeeJack\\server\\index.mjs\nand the command is:\nnpm test",
  chatId,
);
console.log("\n=== TECH PRESERVE");
console.log(
  JSON.stringify(
    {
      model: tech.model,
      renderer_used: tech.rendererUsed,
      total_ms: tech.totalMs,
      reply: tech.reply,
    },
    null,
    2,
  ),
);
if (!tech.reply.includes(String.raw`C:\Users\Abdul\CoffeeJack\server\index.mjs`)) {
  console.error("FAIL path not preserved", tech.reply);
  process.exitCode = 1;
}
if (!tech.reply.includes("npm test")) {
  console.error("FAIL command not preserved", tech.reply);
  process.exitCode = 1;
}

const t4 = transcript[3];
if (t4.style?.language !== "en") {
  console.error("FAIL turn 4 must be English", t4.style);
  process.exitCode = 1;
}
if (/\bbutter\b/i.test(t4.reply)) {
  console.error("FAIL butter calque", t4.reply);
  process.exitCode = 1;
}
if (t4.renderer_used) {
  console.error("FAIL English must not use renderer");
  process.exitCode = 1;
}
const t6 = transcript[5];
if (t6.style?.language !== "ar" || t6.style?.arabic_style !== "jeddawi") {
  console.error("FAIL turn 6 style", t6.style);
  process.exitCode = 1;
}
const t3 = transcript[2];
if (/\bbutter\b|زبدة الطعام/i.test(t3.reply)) {
  console.error("FAIL gist became butter", t3.reply);
  process.exitCode = 1;
}
const t10 = transcript[9];
if (!/إنت يا عبدالرحمن/.test(t10.reply)) {
  console.error("FAIL persona reply", t10.reply);
  process.exitCode = 1;
}
if (t10.renderer_used) {
  console.error("FAIL persona must not use renderer");
  process.exitCode = 1;
}

const sticky = transcript.filter((r) =>
  ["English now", "what if I can't go today?", "ارجع جداوي"].includes(r.user),
);
const switchedAway = sticky.filter((r) => r.model && r.model !== "qwen3:14b");
if (switchedAway.length) {
  console.error(
    "FAIL Jeddawi session unloaded 14b",
    switchedAway.map((r) => ({ user: r.user, model: r.model })),
  );
  process.exitCode = 1;
}

const avg =
  jeddawiTotals.length > 0
    ? Math.round(
        jeddawiTotals.reduce((a, b) => a + b, 0) / jeddawiTotals.length,
      )
    : 0;
const rendererTurns = transcript.filter((r) => r.renderer_used).length;

console.log("\nchatId", chatId);
console.log(
  "\nJeddawi avg total_ms=",
  avg,
  "over",
  jeddawiTotals.length,
  "turns; renderer_used count=",
  rendererTurns,
);
console.log("\n=== TRANSCRIPT ===");
for (const row of transcript) {
  console.log(
    `T${row.turn} [model=${row.model}|loaded=${row.model_already_loaded}|load_ms=${row.model_load_ms ?? "-"}|renderer=${row.renderer_used}|ft=${row.first_token_ms ?? "-"}|total=${row.total_ms}ms]`,
  );
  console.log(`  U: ${row.user.replace(/\n/g, " / ")}`);
  console.log(`  J: ${row.reply}`);
}
