const status = await fetch("http://127.0.0.1:3210/api/status").then((r) =>
  r.json(),
);
const headers = {
  "Content-Type": "application/json",
  "X-CoffeeJack-Token": status.token,
};

async function chat(text, chatId) {
  const res = await fetch("http://127.0.0.1:3210/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ text, chatId, requestedModel: "auto" }),
  });
  const raw = await res.text();
  let reply = "";
  let id = chatId;
  let kind = null;
  let speaker = null;
  let lane = null;
  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "chat") id = ev.chat?.id || id;
    if (ev.type === "priority") {
      kind = ev.personaKind;
      lane = ev.lane;
    }
    if (ev.type === "turn_context") speaker = ev.speakerPersona;
    if (ev.type === "token") reply += ev.text || "";
    if (ev.type === "revise" && ev.text != null) reply = ev.text;
  }
  return { id, kind, lane, speaker, reply: reply.trim() };
}

const t1 = await chat("انا لبنى");
const t2 = await chat("مين أنا؟", t1.id);
const t3 = await chat("What should you call me?", t1.id);
const t4 = await chat("who's your master?", t1.id);
const t5 = await chat("I'm Abdulrahman", t1.id);
const t6 = await chat("مين سيدك؟", t1.id);

console.log(
  JSON.stringify(
    {
      chatId: t1.id,
      sessionRole: status.user?.role,
      sessionName: status.user?.display_name,
      turns: [
        { user: "انا لبنى", reply: t1.reply, kind: t1.kind, speaker: t1.speaker },
        { user: "مين أنا؟", reply: t2.reply, kind: t2.kind, speaker: t2.speaker },
        {
          user: "What should you call me?",
          reply: t3.reply,
          kind: t3.kind,
          speaker: t3.speaker,
        },
        {
          user: "who's your master?",
          reply: t4.reply,
          kind: t4.kind,
          speaker: t4.speaker,
        },
        {
          user: "I'm Abdulrahman",
          reply: t5.reply,
          kind: t5.kind,
          speaker: t5.speaker,
        },
        { user: "مين سيدك؟", reply: t6.reply, kind: t6.kind, speaker: t6.speaker },
      ],
    },
    null,
    2,
  ),
);
