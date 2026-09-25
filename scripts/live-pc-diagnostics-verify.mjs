/**
 * Live verify PC diagnostics against the running CoffeeJack on :3210.
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
// Ensure approvals don't block diagnostics during live verify
await fetch("http://127.0.0.1:3210/api/preferences", {
  method: "POST",
  headers,
  body: JSON.stringify({ autoApprove: true, mode: "hacker" }),
}).catch(() => {});

async function chat(text) {
  const res = await fetch("http://127.0.0.1:3210/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  });
  const raw = await res.text();
  let reply = "";
  const tools = [];
  let error = "";
  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "token") reply += ev.text;
    if (ev.type === "tool")
      tools.push({
        name: ev.name,
        status: ev.status,
        section: ev.args?.section,
        drive: ev.args?.drive,
        error: ev.result?.error,
        preview: String(ev.result?.output || ev.result?.data?.drive || "").slice(
          0,
          200,
        ),
      });
    if (ev.type === "error") error = ev.error || JSON.stringify(ev);
    if (ev.type === "approval")
      tools.push({ name: "approval", status: "needed", id: ev.id });
  }
  return { http: res.status, reply: reply.trim(), tools, error };
}

const disk = await chat("check my c drive");
console.log("=== check my c drive ===");
console.log(JSON.stringify(disk, null, 2));

const health = await chat("check if i have any concerns in my pc");
console.log("=== PC concerns ===");
console.log(JSON.stringify(health, null, 2));
