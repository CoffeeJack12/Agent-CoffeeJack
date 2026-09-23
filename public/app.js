import { jackBrand, mountBranding } from "/branding.js";
import { marked } from "/vendor/marked.esm.js";
import DOMPurify from "/vendor/purify.es.mjs";
const $ = (selector) => document.querySelector(selector);
mountBranding();
try {
  document.body.dataset.theme =
    localStorage.getItem("coffeejack-theme") || "dark";
} catch {
  document.body.dataset.theme = "dark";
}
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
  persona: "شخصية Jack",
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
  element.dataset.text = text;
  element.innerHTML = DOMPurify.sanitize(
    marked.parse(text, { breaks: true, gfm: true }),
    {
      ALLOWED_TAGS: [
        "p",
        "br",
        "strong",
        "em",
        "del",
        "ul",
        "ol",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "pre",
        "code",
        "blockquote",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "hr",
        "a",
      ],
      ALLOWED_ATTR: ["href", "title"],
    },
  );
  for (const node of element.querySelectorAll("p,li,h1,h2,h3,h4,blockquote"))
    node.dir = "auto";
  for (const link of element.querySelectorAll("a")) {
    if (!/^https?:\/\//i.test(link.getAttribute("href") ?? "")) {
      link.removeAttribute("href");
      continue;
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  for (const block of element.querySelectorAll("pre")) {
    const copy = document.createElement("button");
    copy.className = "copy-code";
    copy.textContent = "نسخ الكود";
    copy.onclick = () =>
      copyText(block.querySelector("code")?.textContent ?? "", copy);
    block.append(copy);
  }
}
async function copyText(text, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "تم النسخ ✓";
  } catch {
    button.textContent = "تعذّر النسخ";
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1600);
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
    if(status.preferences) $("#jackMode").value=status.preferences.mode;
    state.token = status.token;
    if (status.jack) updateSelfModel(status.jack);
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
    if (status.jack?.persona?.language)
      setComposerPlaceholder(status.jack.persona.language);
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
  filterHistory();
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
  syncComposer();
  history().catch(report);
}
function addMessage(role, text = "") {
  $("#welcome").classList.add("hidden");
  const el = document.createElement("article");
  el.className = "message " + role;
  el.innerHTML = `${role === "assistant" ? '<div class="message-head"> Jack</div>' : ""}<div class="message-content" dir="auto"></div>`;
  if (role === "assistant") el.querySelector(".message-head").prepend(jackBrand());
  if (role === "assistant") {
    const copy = document.createElement("button");
    copy.className = "copy-reply";
    copy.textContent = "نسخ الرد";
    copy.onclick = () =>
      copyText(el.querySelector(".message-content").dataset.text ?? "", copy);
    el.querySelector(".message-head").append(copy);
  }
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
  if (name === "persona") loadPersona().catch(report);
}
function syncPromptDirection() {
  const el = $("#prompt");
  if (el.value) {
    el.dir = "auto";
    return;
  }
  el.dir = el.classList.contains("placeholder-ltr") ? "ltr" : "rtl";
}
function resizePrompt() {
  const el = $("#prompt");
  el.style.height = "auto";
  el.style.height = Math.min(Math.max(el.scrollHeight, 24), 200) + "px";
}
function syncComposer() {
  const empty = !$("#prompt").value.trim();
  const idle = state.busy || empty;
  $("#send").classList.toggle("is-idle", idle);
  $("#send").classList.toggle("hidden", state.busy);
  $("#send").setAttribute("aria-disabled", String(idle));
  $("#stop").classList.toggle("hidden", !state.busy);
  syncPromptDirection();
  resizePrompt();
}
function setComposerPlaceholder(language) {
  const english = language === "en";
  $("#prompt").placeholder = english ? "Message Jack..." : "اكتب لـ Jack...";
  $("#prompt").classList.toggle("placeholder-ltr", english);
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
  const draft = $("#prompt").value;
  const draftAttachments = [...state.attachments];
  let failed = false;
  const text = draft.trim();
  if (!text || state.busy) return;
  state.busy = true;
  syncComposer();
  notice();
  addMessage("user", text);
  const userEl = $("#messages").lastElementChild;
  const answer = addMessage("assistant");
  const content = answer.querySelector(".message-content");
  const thinking = document.createElement("div");
  thinking.className = "thinking";
  thinking.innerHTML = "<i></i><i></i><i></i><span>Jack يجهّز الرد…</span>";
  answer.append(thinking);
  let full = "";
  let accepted = false;
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
    accepted = true;
    $("#prompt").value = "";
    syncComposer();
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
          thinking.remove();
          full += item.text;
          renderText(content, full);
        }
        if (item.type === "routing") {
          $("#modelLabel").textContent =
            `${item.model} · ${item.kind}${item.fallback ? " · بديل محلي" : ""}`;
        }
        if (item.type === "round")
          $("#runStatus").textContent = `Jack يعمل · الخطوة ${item.round}`;
        if (item.type === "tool") {
          thinking.remove();
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
          failed = true;
          notice(item.error);
          if (!full) content.textContent = item.error;
          content.classList.add("error-text");
        }
        if (item.type === "done")
          $("#runStatus").textContent = "اكتمل الرد · على جهازك";
      }
      if (
        window.innerHeight + window.scrollY >=
        document.body.scrollHeight - 450
      )
        scrollBottom();
    }
  } catch (e) {
    failed = true;
    report(e);
    if (!full) content.textContent = e.message;
    if (!accepted) {
      userEl.remove();
      answer.remove();
      if (!$("#messages").children.length)
        $("#welcome").classList.remove("hidden");
      if (!$("#prompt").value) $("#prompt").value = draft;
    }
  } finally {
    if (failed && !$("#prompt").value) {
      $("#prompt").value = draft;
      state.attachments = draftAttachments;
      drawAttachments();
    }
    thinking.remove();
    state.busy = false;
    $("#runStatus").textContent = "";
    $("#approval").classList.add("hidden");
    await history().catch(report);
    await refreshStatus();
    syncComposer();
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
$("#prompt").oninput = syncComposer;
$("#chatForm").addEventListener("pointerdown", (e) => {
  if (!e.target.closest("button, select, a")) $("#prompt").focus();
});
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
      syncComposer();
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
  await loadPreferences();
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
function filterHistory() {
  const query = $("#historySearch").value.trim().toLocaleLowerCase();
  for (const row of document.querySelectorAll(".history-row"))
    row.hidden = !row
      .querySelector(".history-item")
      .textContent.toLocaleLowerCase()
      .includes(query);
}
$("#historySearch").oninput = filterHistory;
$("#mobileNew").onclick = newChat;
$("#personalityShortcut").onclick = () => showView("persona");
$("#themeToggle").onclick = () => {
  const theme = document.body.dataset.theme === "light" ? "dark" : "light";
  document.body.dataset.theme = theme;
  try {
    localStorage.setItem("coffeejack-theme", theme);
  } catch {}
  $("#themeToggle").setAttribute("aria-pressed", String(theme === "light"));
};
$("#themeToggle").setAttribute(
  "aria-pressed",
  String(document.body.dataset.theme === "light"),
);
function scrollBottom() {
  window.scrollTo({
    top: document.documentElement.scrollHeight,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
  });
}
$("#jumpBottom").onclick = scrollBottom;
window.addEventListener(
  "scroll",
  () =>
    $("#jumpBottom").classList.toggle(
      "hidden",
      state.view !== "chat" ||
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 350,
    ),
  { passive: true },
);

const presets = {
  playful: { humor: "playful", detail: "concise" },
  focused: { humor: "off", detail: "concise" },
  calm: { humor: "subtle", detail: "balanced" },
};
function personaValues() {
  const form = $("#personaForm");
  return Object.fromEntries(
    ["language", "dialect", "humor", "detail"].map((key) => [
      key,
      form.elements[key].value,
    ]),
  );
}
function previewPersona() {
  const values = personaValues();
  const english = values.language === "en";
  $("#previewQuestion").textContent = english
    ? "Jack, my code broke."
    : values.dialect === "standard"
      ? "يا Jack، توقف الكود عن العمل."
      : "يا Jack، الكود خرب.";
  const examples = english
    ? {
        playful:
          "Send the first error. The code picked drama; we pick the cause, then we break it properly.",
        subtle: "First error. One bug at a time—no speeches.",
        off: "Send the first error and the relevant code. I’ll isolate the cause, patch it, and test.",
      }
    : values.dialect === "standard"
      ? {
          playful:
            "أرسل أول رسالة خطأ. الكود قرر المسرح؛ إحنا نقرر السبب وبعدها نكسر المشكلة.",
          subtle: "أول رسالة خطأ. خطوة واحدة. بلا خطب.",
          off: "أرسل أول رسالة خطأ والجزء المرتبط بها من الكود. أحدد السبب، أصلحه، ثم أختبر.",
        }
      : {
          playful:
            "هات أول رسالة خطأ. الكود اختار الدراما؛ إحنا نمسك السبب ونخلّصه. قهوتك اختيارية.",
          subtle: "خلّينا نشوف أول رسالة خطأ. خطوة خطوة، من غير تمثيل.",
          off: "أرسل أول رسالة خطأ والكود المرتبط بها. أحدد السبب، أعدّله، وأختبر.",
        };
  $("#personaPreview").textContent = examples[values.humor];
  for (const button of document.querySelectorAll("[data-persona-preset]")) {
    const preset = presets[button.dataset.personaPreset];
    const selected =
      preset.humor === values.humor && preset.detail === values.detail;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}
function updateSelfModel(jack) {
  const formatter = new Intl.NumberFormat("ar-SA");
  $("#memoryCount").textContent = formatter.format(jack.memories);
  $("#conversationCount").textContent = formatter.format(jack.conversations);
  $("#toolCount").textContent = formatter.format(jack.completedTools);
  const labels = {
    ready: "جاهز",
    working: "يعمل على طلبك",
    gaming: "الأولوية للعبة",
  };
  $("#selfState").textContent = labels[jack.state] || "جاهز";
  $("#jackPresence").textContent =
    jack.state === "gaming"
      ? "Jack على وضع الألعاب"
      : jack.state === "working"
        ? "Jack يعمل على طلبك"
        : "Jack هنا";
  $("#personalityShortcut").textContent = {
    playful: "حاد، ساخر وقت اللزوم",
    subtle: "هادي، وفيه حدّة خفيفة",
    off: "مركّز على النتيجة",
  }[jack.persona.humor];
  const r = jack.lastReflection;
  if (r) {
    const result =
      {
        completed: "اكتمل الرد",
        cancelled: "توقّف بطلبك",
        error: "توقّف بسبب خطأ",
        "step-limit": "وصل إلى حد الخطوات",
      }[r.outcome] || r.outcome;
    $("#lastReflection").textContent =
      `آخر طلب: ${result} · ${r.successfulTools} أداة نجحت · ${r.failedTools} أخطاء أدوات · ${r.durationSeconds} ثانية. هذه نتائج تنفيذ فعلية، وليست أفكارًا داخلية.`;
  } else
    $("#lastReflection").textContent = "تظهر هنا نتيجة آخر طلب بعد تنفيذه.";
}
async function loadPersona() {
  const jack = await api("persona");
  if(preferenceCatalog){const language=$("#personaForm").elements.language;language.innerHTML="";for(const [id,label]of Object.entries(preferenceCatalog.languages))language.add(new Option(label,id));}
  for (const [key, value] of Object.entries(jack.persona))
    if ($("#personaForm").elements[key])
      $("#personaForm").elements[key].value = value;
  $("#personaMessage").textContent = "";
  updateSelfModel(jack);
  setComposerPlaceholder(jack.persona.language);
  previewPersona();
}
$("#personaForm").onchange = () => {
  previewPersona();
  $("#personaMessage").textContent =
    "احفظ لتطبيق التغييرات على الردود القادمة.";
};
for (const button of document.querySelectorAll("[data-persona-preset]"))
  button.onclick = () => {
    for (const [key, value] of Object.entries(
      presets[button.dataset.personaPreset],
    ))
      $("#personaForm").elements[key].value = value;
    previewPersona();
    $("#personaMessage").textContent =
      "احفظ لتطبيق التغييرات على الردود القادمة.";
  };
$("#personaForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const jack = await api("persona", {
      method: "POST",
      body: personaValues(),
    });
    updateSelfModel(jack);
    setComposerPlaceholder(jack.persona.language);
    $("#personaMessage").textContent = "انحفظت. هذا أسلوبي من الآن ✓";
  } catch (error) {
    $("#personaMessage").textContent = error.message;
  }
};
let preferenceCatalog;
async function loadPreferences() {
 const data=await api('preferences');preferenceCatalog=data.catalog;
 const form=$('#preferenceForm');form.innerHTML='';
 const sections=[['General / عام',['language','address','name','customAddress']],['Personality / الشخصية',['tone','verbosity','humor','initiative']],['Modes / الأنماط',['mode']]];
 const labels={language:'Language / اللغة',address:'Address me as / اللقب',name:'Name / الاسم',customAddress:'Custom address / لقب مخصص',tone:'Tone / النبرة',verbosity:'Verbosity / التفصيل',humor:'Humor / المزاح',initiative:'Initiative / المبادرة',mode:'Default mode / النمط الافتراضي'};
 for(const [heading,keys] of sections){
  const card=document.createElement('div');card.className='setting-card';const h=document.createElement('h3');h.textContent=heading;card.append(h);
  for(const key of keys){const label=document.createElement('label');label.textContent=labels[key];
   const input=document.createElement(['name','customAddress'].includes(key)?'input':'select');input.name=key;
   if(input.tagName==='SELECT')for(const value of data.catalog.options[key]){const title=key==='language'?data.catalog.languages[value]:key==='mode'?data.catalog.modes[value].label:value[0].toUpperCase()+value.slice(1);input.add(new Option(title,value));}
   else {input.maxLength=40;input.dir='auto';}
   input.value=data.preferences[key];label.append(input);card.append(label);
  }
  if(keys.includes('mode')){const hint=document.createElement('p');hint.id='modeDescription';hint.className='hint';card.append(hint);}
  form.append(card);
 }
 const card=document.createElement('div');card.className='setting-card';card.innerHTML='<h3>Capabilities / القدرات</h3><p class="hint">Tool choices apply in the backend. Terminal and browser are powerful tools; approvals still apply.</p><div id="capabilityChoices"></div><button type="button" id="resetCapabilities" class="ghost">Use mode defaults / إعدادات النمط</button>';form.append(card);
 let custom=data.preferences.capabilities!==null;
 const drawPacks=()=>{const mode=form.elements.mode.value;$('#modeDescription').textContent=data.catalog.modes[mode].description;const packs=custom?data.preferences.capabilities:data.catalog.modes[mode].packs;$('#capabilityChoices').innerHTML='';for(const [key,title] of Object.entries(data.catalog.packs)){const label=document.createElement('label');label.className='toggle-row';const input=document.createElement('input');input.type='checkbox';input.name='pack';input.value=key;input.checked=packs.includes(key);input.onchange=()=>{custom=true;data.preferences.capabilities=[...form.querySelectorAll('[name="pack"]:checked')].map(n=>n.value);};label.append(input,document.createTextNode(title));$('#capabilityChoices').append(label);}};
 form.elements.mode.onchange=drawPacks;$('#resetCapabilities').onclick=()=>{custom=false;drawPacks();};drawPacks();
 const footer=document.createElement('div');footer.className='settings-footer';footer.innerHTML='<button class="primary">Save preferences / حفظ التفضيلات</button><span id="preferenceMessage" role="status"></span>';form.append(footer);
 form.onsubmit=async event=>{event.preventDefault();try{const values={};for(const [,keys] of sections)for(const key of keys)values[key]=form.elements[key].value;values.capabilities=custom?[...form.querySelectorAll('[name="pack"]:checked')].map(n=>n.value):null;await api('preferences',{method:'POST',body:values});$('#preferenceMessage').textContent='Saved / تم الحفظ';await refreshStatus();}catch(error){$('#preferenceMessage').textContent=error.message;}};
 const selector=$('#jackMode');selector.innerHTML='';for(const [id,mode]of Object.entries(data.catalog.modes))selector.add(new Option(mode.label,id));selector.value=data.preferences.mode;
}
$('#jackMode').onchange=async event=>{try{await api('preferences',{method:'POST',body:{mode:event.target.value}});await refreshStatus();}catch(error){report(error);event.target.value=state.status?.preferences?.mode??'jarvis';}};

await refreshStatus();
await loadPreferences().catch(report);
await history().catch(report);
syncComposer();
setInterval(refreshStatus, 15000);
