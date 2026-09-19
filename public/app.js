const $ = (selector) => document.querySelector(selector);
const state = {
  token: "",
  chatId: null,
  busy: false,
  attachments: [],
  status: null,
  view: "chat",
};
const titles = {
  chat: "المحادثة",
  memory: "الذاكرة",
  activity: "سجل التنفيذ",
  settings: "الإعدادات",
};
const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function renderText(element, text) {
  // Only fenced code is formatted; all model/user HTML is escaped.
  element.innerHTML = text
    .split(/(```[\s\S]*?```)/g)
    .map((part) =>
      part.startsWith("```")
        ? `<pre><code>${escape(part.slice(3, -3).replace(/^\w*\n/, ""))}</code></pre>`
        : escape(part),
    )
    .join("");
}
async function api(route, options = {}) {
  const response = await fetch("/api/" + route, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": state.token,
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "تعذر تنفيذ الطلب");
  return data;
}
function notice(text = "") {
  $("#notice").textContent = text;
  $("#notice").classList.toggle("hidden", !text);
}
async function refreshStatus() {
  try {
    const status = await api("status");
    state.status = status;
    state.token = status.token;
    const ready =
      !status.modelError &&
      status.models.some((m) => m.name === status.settings.model);
    $("#connectionDot").classList.toggle("ready", ready && !status.gaming);
    $("#connectionLabel").textContent = status.gaming
      ? "ألعابك أولًا"
      : ready
        ? "متصل محليًا"
        : "الموديل غير جاهز";
    $("#modelLabel").textContent = `${status.settings.model} · Local`;
    $("#gaming").classList.toggle("on", status.gaming);
    $("#gaming").setAttribute("aria-pressed", String(status.gaming));
    $("#gaming span").textContent = status.gaming
      ? "وضع الألعاب مفعّل"
      : "وضع الألعاب";
    if (status.gaming)
      notice(
        "وضع الألعاب مفعّل؛ مهام Jack متوقفة والموديلات تُفرّغ من الذاكرة.",
      );
    else if (status.modelError)
      notice(
        "محرك الذكاء المحلي غير متصل. شغّل CoffeeJack من ملف Start CoffeeJack.",
      );
    else if (!ready)
      notice(
        "الموديل المحدد غير مثبت بعد. أكمل تنزيله أو اختر موديلًا متاحًا في الإعدادات.",
      );
    else if (!state.busy) notice();
    if (status.approvals.length) showApproval(status.approvals[0]);
    return status;
  } catch (e) {
    $("#connectionLabel").textContent = "غير متصل";
    $("#connectionDot").classList.remove("ready");
  }
}
async function history() {
  const chats = await api("chats");
  $("#history").innerHTML = "";
  if (!chats.length)
    $("#history").innerHTML =
      '<div class="empty">بداية جديدة،<br>وأفكار كثيرة تنتظر.</div>';
  for (const chat of chats) {
    const row = document.createElement("div");
    row.className =
      "history-row" + (chat.id === state.chatId ? " selected" : "");
    const open = document.createElement("button");
    open.className = "history-item";
    open.textContent = chat.title;
    open.title = chat.title;
    open.onclick = async () => {
      if (state.busy) return notice("أوقف المهمة الحالية أولًا.");
      state.chatId = chat.id;
      showView("chat");
      $("#messages").innerHTML = "";
      for (const m of await api("chats/" + chat.id))
        addMessage(m.role, m.content);
      $("#welcome").classList.add("hidden");
      await history();
    };
    const del = document.createElement("button");
    del.className = "delete";
    del.textContent = "×";
    del.title = "حذف المحادثة";
    del.onclick = async () => {
      if (state.busy) return;
      if (!confirm("حذف هذه المحادثة؟")) return;
      await api("chats/" + chat.id, { method: "DELETE" });
      if (state.chatId === chat.id) newChat();
      else history();
    };
    row.append(open, del);
    $("#history").append(row);
  }
}
function newChat() {
  if (state.busy) return notice("أوقف المهمة الحالية أولًا.");
  state.chatId = null;
  state.attachments = [];
  drawAttachments();
  $("#messages").innerHTML = "";
  $("#welcome").classList.remove("hidden");
  showView("chat");
  $("#prompt").focus();
  history().catch(report);
}
function addMessage(role, text = "") {
  $("#welcome").classList.add("hidden");
  const el = document.createElement("article");
  el.className = "message " + role;
  el.innerHTML = `<div class="message-head">${role === "assistant" ? '<img src="/favicon.svg" alt=""> Jack' : "◌ أنت"}</div><div class="message-content" dir="auto"></div>`;
  renderText(el.querySelector(".message-content"), text);
  $("#messages").append(el);
  return el;
}
function report(error) {
  notice(error.message || String(error));
}
function showView(name) {
  state.view = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $("#" + name + "View").classList.remove("hidden");
  $("#pageTitle").textContent = titles[name];
  document
    .querySelectorAll(".nav")
    .forEach((n) => n.classList.toggle("active", n.dataset.view === name));
  if (name === "memory") loadMemories().catch(report);
  if (name === "activity") loadEvents().catch(report);
  if (name === "settings") loadSettings().catch(report);
}
function scrollBottom() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}
function showApproval(event) {
  const el = $("#approval");
  el.classList.remove("hidden");
  el.innerHTML = `<h3>Jack يحتاج موافقتك: ${escape(event.name)}</h3><pre>${escape(JSON.stringify(event.args, null, 2))}</pre><button class="primary" id="allowTool">تنفيذ هذه الخطوة</button><button class="ghost" id="denyTool">رفض</button>`;
  for (const [id, allow] of [
    ["allowTool", true],
    ["denyTool", false],
  ])
    $("#" + id).onclick = async () => {
      try {
        await api("approve/" + event.id, { method: "POST", body: { allow } });
        el.classList.add("hidden");
      } catch (e) {
        report(e);
        el.classList.add("hidden");
      }
    };
}
$("#chatForm").onsubmit = async (event) => {
  event.preventDefault();
  const text = $("#prompt").value.trim();
  if (!text || state.busy) return;
  state.busy = true;
  $("#send").disabled = true;
  $("#stop").classList.remove("hidden");
  $("#prompt").value = "";
  notice();
  addMessage("user", text);
  const answer = addMessage("assistant");
  const content = answer.querySelector(".message-content");
  let full = "";
  const steps = [];
  $("#runStatus").textContent = "Jack يفكر…";
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CoffeeJack-Token": state.token,
      },
      body: JSON.stringify({
        text,
        chatId: state.chatId,
        mode: $("#mode").value,
        attachments: state.attachments.map((a) => a.path),
      }),
    });
    if (!response.ok) throw new Error((await response.json()).error);
    state.attachments = [];
    drawAttachments();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const item = JSON.parse(line);
        if (item.type === "chat") {
          state.chatId = item.chat.id;
          history().catch(report);
        }
        if (item.type === "token") {
          full += item.text;
          renderText(content, full);
        }
        if (item.type === "round")
          $("#runStatus").textContent = `Jack يعمل · الخطوة ${item.round}`;
        if (item.type === "tool") {
          let el;
          if (item.status === "running") {
            el = document.createElement("details");
            el.className = "tool-step";
            el.dataset.name = item.name;
            el.innerHTML = `<summary>◌ ${escape(item.name)} · يعمل</summary><pre>${escape(JSON.stringify(item.args, null, 2))}</pre>`;
            answer.append(el);
            steps.push(el);
          } else {
            el = [...steps]
              .reverse()
              .find((s) => s.dataset.name === item.name && !s.dataset.done);
            if (el) {
              el.dataset.done = "1";
              el.classList.toggle("error", item.status === "error");
              el.querySelector("summary").textContent =
                `${item.status === "error" ? "!" : "✓"} ${item.name} · ${item.status === "error" ? "تعذر التنفيذ" : "اكتمل"}`;
              el.querySelector("pre").textContent = JSON.stringify(
                item.result,
                null,
                2,
              );
              if (
                item.result?.image &&
                /^\/artifacts\/[a-z]+-\d+\.png$/.test(item.result.image)
              ) {
                const img = document.createElement("img");
                img.src = item.result.image;
                img.alt = "لقطة من الأداة";
                el.append(img);
              }
            }
          }
        }
        if (item.type === "approval") showApproval(item);
        if (item.type === "error") {
          notice(item.error);
          if (!full) content.textContent = item.error;
          content.classList.add("error-text");
        }
        if (item.type === "done")
          $("#runStatus").textContent = `اكتمل · ${item.tokens} tokens محليًا`;
      }
      if (
        window.innerHeight + window.scrollY >=
        document.body.scrollHeight - 450
      )
        scrollBottom();
    }
  } catch (e) {
    report(e);
    if (!full) content.textContent = e.message;
  } finally {
    state.busy = false;
    $("#send").disabled = false;
    $("#stop").classList.add("hidden");
    $("#approval").classList.add("hidden");
    await history().catch(report);
    await refreshStatus();
    $("#prompt").focus();
  }
};
$("#stop").onclick = () => api("stop", { method: "POST" }).catch(report);
$("#prompt").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#chatForm").requestSubmit();
  }
};
$("#newChat").onclick = newChat;
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    newChat();
  }
});
document
  .querySelectorAll(".nav")
  .forEach((button) => (button.onclick = () => showView(button.dataset.view)));
document.querySelectorAll("[data-prompt]").forEach(
  (button) =>
    (button.onclick = () => {
      $("#prompt").value = button.dataset.prompt;
      $("#mode").value = button.dataset.mode || "auto";
      $("#prompt").focus();
    }),
);
$("#gaming").onclick = async () => {
  try {
    $("#gaming").disabled = true;
    await api("gaming", {
      method: "POST",
      body: { enabled: !state.status?.gaming },
    });
    await refreshStatus();
  } catch (e) {
    report(e);
  } finally {
    $("#gaming").disabled = false;
  }
};
function drawAttachments() {
  $("#attachments").innerHTML = "";
  state.attachments.forEach((file, i) => {
    const el = document.createElement("span");
    el.className = "attachment";
    el.textContent = file.name;
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.onclick = () => {
      state.attachments.splice(i, 1);
      drawAttachments();
    };
    el.append(remove);
    $("#attachments").append(el);
  });
}
$("#attach").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = async () => {
  const file = $("#fileInput").files[0];
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024)
      throw new Error("الحد الأعلى للملف 20 MB.");
    if (state.attachments.length >= 5) throw new Error("الحد الأعلى 5 ملفات.");
    $("#attach").disabled = true;
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    state.attachments.push(
      await api("upload", { method: "POST", body: { name: file.name, data } }),
    );
    drawAttachments();
  } catch (e) {
    report(e);
  } finally {
    $("#attach").disabled = false;
    $("#fileInput").value = "";
  }
};
async function loadMemories() {
  const memories = await api("memories");
  $("#memories").innerHTML = "";
  if (!memories.length)
    $("#memories").innerHTML =
      '<div class="empty">الذاكرة تبدأ معك. أضف أول تفضيل أو ملاحظة.</div>';
  for (const m of memories) {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `<small>${escape(m.kind)} · ${new Date(m.created).toLocaleDateString("ar-SA")}</small><p>${escape(m.content)}</p><button class="delete" aria-label="حذف الذاكرة">×</button>`;
    el.querySelector("button").onclick = async () => {
      await api("memories/" + m.id, { method: "DELETE" });
      loadMemories();
    };
    $("#memories").append(el);
  }
}
$("#memoryForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("memories", {
      method: "POST",
      body: { content: $("#memoryInput").value, kind: "preference" },
    });
    $("#memoryInput").value = "";
    await loadMemories();
  } catch (e) {
    report(e);
  }
};
async function loadEvents() {
  const events = await api("events");
  $("#events").innerHTML = events.length
    ? ""
    : '<div class="empty">ما فيه خطوات تنفيذ بعد. ستظهر الأدوات ونتائجها هنا.</div>';
  for (const item of events) {
    const el = document.createElement("details");
    el.className = "card";
    el.innerHTML = `<summary>${item.status === "done" ? "✓" : "!"} ${escape(item.tool)} <small> · ${new Date(item.created).toLocaleString("ar-SA")}</small></summary><pre>${escape(JSON.stringify(JSON.parse(item.detail), null, 2))}</pre>`;
    $("#events").append(el);
  }
}
$("#refreshEvents").onclick = () => loadEvents().catch(report);
async function loadSettings() {
  const status = await refreshStatus();
  if (!status) return;
  const form = $("#settingsForm");
  for (const select of form.querySelectorAll(".model-select")) {
    select.innerHTML = "";
    if (select.name !== "model") {
      const opt = new Option("نفس الموديل الأساسي", "");
      select.add(opt);
    }
    const names = [
      ...new Set(
        [
          ...status.models.map((m) => m.name),
          status.settings[select.name],
        ].filter(Boolean),
      ),
    ];
    for (const name of names) select.add(new Option(name, name));
    select.value = status.settings[select.name];
  }
  for (const key of ["workspace", "instructions"])
    form.elements[key].value = status.settings[key];
  for (const key of ["autoApprove", "autoGaming"])
    form.elements[key].checked = status.settings[key];
  form.elements.gameProcesses.value = status.settings.gameProcesses.join(", ");
}
$("#settingsForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("settings", {
      method: "POST",
      body: {
        model: f.elements.model.value,
        codingModel: f.elements.codingModel.value,
        visionModel: f.elements.visionModel.value,
        workspace: f.elements.workspace.value,
        instructions: f.elements.instructions.value,
        autoApprove: f.elements.autoApprove.checked,
        autoGaming: f.elements.autoGaming.checked,
        gameProcesses: f.elements.gameProcesses.value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
      },
    });
    $("#settingsMessage").textContent = "تم حفظ الإعدادات.";
    await refreshStatus();
  } catch (err) {
    $("#settingsMessage").textContent = err.message;
  }
};
await refreshStatus();
await history().catch(report);
setInterval(refreshStatus, 15000);
