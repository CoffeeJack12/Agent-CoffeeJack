/**
 * Live verification against the real CoffeeJack process on :3210.
 */
const base = process.env.COFFEEJACK_URL || "http://127.0.0.1:3210";

async function status() {
  const res = await fetch(base + "/api/status");
  return res.json();
}

async function chat(token, text, chatId) {
  const res = await fetch(base + "/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": token,
    },
    body: JSON.stringify({ text, chatId, requestedModel: "auto" }),
  });
  const raw = await res.text();
  const events = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "parse_error", line };
      }
    });
  const tokens = events
    .filter((e) => e.type === "token" || e.type === "revise")
    .map((e) => e.text || "")
    .join("");
  return {
    status: res.status,
    priority: events.find((e) => e.type === "priority") || null,
    routing: events.find((e) => e.type === "routing") || null,
    selfRepair: events.find((e) => e.type === "self_repair") || null,
    tools: events.filter((e) => e.type === "tool").map((e) => ({
      name: e.name,
      status: e.status,
    })),
    reply: tokens.slice(0, 400),
    chatId: events.find((e) => e.type === "chat")?.chat?.id || chatId,
  };
}

const phrases = [
  "self repair",
  "check if there's any errors within your code",
  "who's your master?",
  "I'm your master",
];

const st = await status();
const token = st.token;
if (!token) {
  console.error("No local session token from /api/status", st);
  process.exit(1);
}
console.log(
  JSON.stringify({
    user: st.user?.name || st.user?.display_name,
    role: st.user?.role,
    pidHint: "see restart log",
  }),
);

let chatId;
for (const text of phrases) {
  const result = await chat(token, text, chatId);
  chatId = result.chatId;
  console.log(JSON.stringify({ text, ...result }, null, 2));
  await new Promise((r) => setTimeout(r, 200));
}
