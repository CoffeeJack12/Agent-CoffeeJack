/**
 * Live multi-turn conversation-context verification on one persistent chat.
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
  let firstTokenAt = null;
  const res = await fetch("http://127.0.0.1:3210/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ text, chatId }),
  });
  const raw = await res.text();
  const totalMs = Math.round(performance.now() - t0);
  let reply = "";
  let ctx = null;
  let nextChatId = chatId;
  let error = "";
  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "chat") nextChatId = ev.chat?.id || nextChatId;
    if (ev.type === "turn_context") ctx = ev;
    if (ev.type === "token") {
      if (firstTokenAt == null) firstTokenAt = Math.round(performance.now() - t0);
      reply += ev.text;
    }
    if (ev.type === "error") error = ev.error || JSON.stringify(ev);
  }
  return {
    http: res.status,
    chatId: nextChatId,
    reply: reply.trim(),
    ctx,
    firstTokenMs: firstTokenAt,
    totalMs,
    error,
  };
}

const turns = [
  "My favorite color for this conversation is purple.",
  "what color did i just tell you?",
  "make your answer shorter",
  "yea",
  "تكلم معايا عربي",
  "كمل بالانجليزي",
];

let chatId;
const results = [];
for (const text of turns) {
  const r = await chat(text, chatId);
  chatId = r.chatId;
  results.push({ text, ...r });
  console.log("\n===", text);
  console.log(
    JSON.stringify(
      {
        intent: r.ctx?.intent,
        taskHint: r.ctx?.taskHint,
        fastPath: r.ctx?.fastPath,
        effectiveIntent: r.ctx?.effectiveIntent,
        transientFacts: r.ctx?.transientFacts,
        languageSwitch: r.ctx?.languageSwitch,
        firstTokenMs: r.firstTokenMs,
        totalMs: r.totalMs,
        reply: r.reply.slice(0, 400),
        error: r.error,
      },
      null,
      2,
    ),
  );
}

// Warm hey latency
const hey = await chat("hey", undefined);
console.log("\n=== hey (fresh chat) latency ===");
console.log({ firstTokenMs: hey.firstTokenMs, totalMs: hey.totalMs, reply: hey.reply.slice(0, 120) });

console.log("\n=== SUMMARY chatId ===", chatId);
