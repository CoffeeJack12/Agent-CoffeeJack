const base = "http://127.0.0.1:3210";
const st = await (await fetch(base + "/api/status")).json();
async function chat(text) {
  const r = await fetch(base + "/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": st.token,
    },
    body: JSON.stringify({ text }),
  });
  const events = (await r.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  const sr = events.find((e) => e.type === "self_repair");
  const reply = events
    .filter((e) => e.type === "token")
    .map((e) => e.text)
    .join("");
  return {
    text,
    kind: sr?.kind,
    canApply: sr?.diagnosis?.canApply ?? sr?.proposal?.canApply,
    files: sr?.diagnosis?.files ?? sr?.proposal?.files,
    rootCause: sr?.diagnosis?.rootCause ?? sr?.proposal?.rootCause,
    summary: sr?.diagnosis?.summary || sr?.diagnosis?.message,
    checks: (sr?.diagnosis?.checksPerformed || sr?.proposal?.checksPerformed || []).map(
      (c) => `${c.id}:${c.status}`,
    ),
    reply: reply.slice(0, 220),
  };
}
for (const t of ["self repair", "check if there's any errors within your code"]) {
  console.log(JSON.stringify(await chat(t), null, 2));
}
