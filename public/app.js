import { jackBrand, mountBranding } from "/branding.js";
import { marked } from "/vendor/marked.esm.js";
import DOMPurify from "/vendor/purify.es.mjs";
import {
  resolveAppLocale,
  t,
  applyDocumentLocale,
  applyStaticI18n,
} from "/i18n.js";
import { createDropdown, mountDropdown } from "/dropdown.js";
import {
  shouldShowCouncilInChat,
  shouldShowToolInChat,
} from "/chat-visibility.js";
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
  locale: "en",
  currentMode: "auto",
  taskMode: "auto",
  requestedModel: "auto",
  modeInitialized: false,
};
const dropdowns = {
  currentMode: null,
  taskMode: null,
  requestedModel: null,
  settingsModels: {},
  persona: {},
};
const tr = (key, vars) => t(key, state.locale, vars);
function modeOptions() {
  return Object.keys(preferenceCatalog?.modes ?? {
    auto: {},
    hacker: {},
    developer: {},
    research: {},
    empathy: {},
    secret_agent: {},
  }).map((value) => ({ value, label: tr(`mode.${value}.label`) }));
}
function applyAppLanguage(appLanguage = "en") {
  const locale = resolveAppLocale(appLanguage);
  state.locale = locale.lang;
  applyDocumentLocale(locale);
  applyStaticI18n(document, state.locale);
  $("#pageTitle").textContent = tr(`page.${state.view}`);
  setComposerPlaceholder();
  mountRoutingDropdowns();
  if (Object.keys(dropdowns.persona).length) mountPersonaDropdowns(personaValues());
}
function mountRoutingDropdowns() {
  if (!$("#jackModeHost") || !$("#taskModeHost") || !$("#modelHost")) return;
  const modes = modeOptions();
  dropdowns.currentMode = mountDropdown("#jackModeHost", {
    options: modes,
    value: state.currentMode || "auto",
    ariaLabel: tr("composer.currentMode"),
    onChange: (value) => {
      state.currentMode = value || "auto";
    },
  });
  dropdowns.taskMode = mountDropdown("#taskModeHost", {
    options: ["auto", "general", "coding", "vision"].map((value) => ({
      value,
      label: tr(`composer.mode.${value}`),
    })),
    value: state.taskMode || "auto",
    ariaLabel: tr("composer.taskType"),
    onChange: (value) => {
      state.taskMode = value || "auto";
    },
  });
  const installed = state.status?.models ?? [];
  dropdowns.requestedModel = mountDropdown("#modelHost", {
    options: [
      { value: "auto", label: tr("settings.autoModel") },
      ...installed.map((model) => ({
        value: model.name,
        label:
          model.label ||
          `${model.name} · ${model.provider || "Ollama"} · ${model.local === false ? tr("composer.modelRemote") : tr("composer.modelLocal")}`,
      })),
    ],
    value: installed.some((m) => m.name === state.requestedModel)
      ? state.requestedModel
      : "auto",
    ariaLabel: tr("settings.autoModel"),
    onChange: (value) => {
      state.requestedModel = value || "auto";
    },
  });
}
const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function renderText(element, text, { streaming = false } = {}) {
  element.dataset.text = text;
  // During streaming, paint plain text immediately — do not wait for markdown.
  if (streaming) {
    element.textContent = text;
    element.dir = "auto";
    return;
  }
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
    copy.textContent = tr("chat.copyCode");
    copy.onclick = () =>
      copyText(block.querySelector("code")?.textContent ?? "", copy);
    block.append(copy);
  }
}
async function copyText(text, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = tr("chat.copied");
  } catch {
    button.textContent = tr("chat.copyFailed");
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1600);
}
function renderProviders(providers, status) {
  const host = $("#providersList");
  if (!host) return;
  host.innerHTML = "";
  const auto = status?.autoRouting;
  if (auto?.general) {
    const legend = document.createElement("div");
    legend.className = "card";
    legend.innerHTML = `<strong>${escape(tr("providers.autoTitle"))}</strong>
      <div class="muted">${escape(tr("providers.providerLine"))}</div>
      <div class="muted">${escape(tr("providers.modelLine"))}</div>
      <div>${escape(tr("providers.autoGeneral"))}: <code>${escape(auto.general)}</code></div>
      <div>${escape(tr("providers.autoReasoning"))}: <code>${escape(auto.reasoning || auto.general)}</code></div>`;
    host.append(legend);
  }
  const list = providers?.length
    ? providers
    : [
        { id: "ollama", name: "Ollama", status: "unavailable", type: "local" },
      ];
  for (const provider of list) {
    // Local-first UI: keep remote rows only when already present from status.
    const row = document.createElement("div");
    row.className = "provider-row";
    const statusKey =
      provider.status ||
      (!provider.enabled
        ? "not_configured"
        : provider.available
          ? "connected"
          : "unavailable");
    const label =
      statusKey === "connected"
        ? tr("providers.connected")
        : statusKey === "unavailable"
          ? tr("providers.unavailable")
          : tr("providers.notConfigured");
    const typeLabel =
      provider.type === "local"
        ? tr("providers.local")
        : provider.type === "remote"
          ? tr("providers.remote")
          : provider.type || "";
    const models =
      provider.modelCount != null
        ? ` · ${provider.modelCount} ${tr("providers.models")}`
        : "";
    const latency =
      provider.latencyMs != null ? ` · ${provider.latencyMs}ms` : "";
    row.innerHTML = `<div><strong>${escape(provider.name || provider.id)}</strong><small>${escape(typeLabel)}${escape(models)}${escape(latency)}</small></div><span>${escape(label)}</span>`;
    host.append(row);
  }
  let refresh = host.parentElement?.querySelector("[data-providers-refresh]");
  if (!refresh && host.parentElement) {
    refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "secondary";
    refresh.dataset.providersRefresh = "1";
    refresh.textContent = tr("providers.refresh");
    refresh.onclick = () => refreshStatus().catch(report);
    host.parentElement.append(refresh);
  }
}
function isPublicRemoteBrowser() {
  const host = String(location.hostname || "").toLowerCase();
  return host !== "127.0.0.1" && host !== "localhost";
}
function isSessionAuthFailure(error) {
  const code = error?.code;
  const message = String(error?.message || "");
  return (
    code === "authentication_required" ||
    code === "session_expired" ||
    message === "Invalid session token" ||
    message === "Your session expired. Please log in again." ||
    message === "Authentication required. Please log in again."
  );
}
let publicLoginRedirect = false;
function leavePublicAppForLogin(error) {
  if (!isPublicRemoteBrowser() || !isSessionAuthFailure(error)) return false;
  publicLoginRedirect = true;
  location.replace("/login");
  return true;
}
function sessionHeaders(extra = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...extra,
  };
  const token = typeof state.token === "string" ? state.token.trim() : "";
  if (token && token !== "undefined")
    headers["X-CoffeeJack-Token"] = token;
  return headers;
}
async function api(route, options = {}) {
  const response = await fetch("/api/" + route, {
    ...options,
    headers: sessionHeaders(options.headers),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || tr("notice.requestFailed"));
    err.code = data.code;
    err.email = data.email;
    throw err;
  }
  return data;
}
function notice(text = "") {
  $("#notice").textContent = text;
  $("#notice").classList.toggle("hidden", !text);
}
function showAccessPending(detail) {
  const panel = $("#accessPending");
  if (!panel) return;
  panel.classList.remove("hidden");
  const detailEl = $("#accessPendingDetail");
  if (detailEl && detail)
    detailEl.textContent = detail;
  document.body.classList.add("access-locked");
}
function hideAccessPending() {
  $("#accessPending")?.classList.add("hidden");
  document.body.classList.remove("access-locked");
}
function renderAccountIdentity(status) {
  const account = $("#accountIdentity");
  const roleEl = $("#profileRole");
  if (!status?.user) return;
  const source =
    status.identitySource === "cloudflare"
      ? tr("account.sourceCloudflare")
      : status.identitySource === "account"
        ? tr("account.sourceCoffeeJack")
        : tr("account.sourceLocal");
  const linked = (status.identities || []).some(
    (i) => i.provider === "cloudflare_access",
  );
  const linkLabel = linked
    ? tr("account.linkedCloudflare")
    : tr("account.localOnly");
  const line = `${status.user.display_name} · ${status.user.role} · ${source}`;
  if (account) account.textContent = `${line} · ${linkLabel}`;
  if (roleEl)
    roleEl.textContent = `${status.user.role} · ${source}`;
}
function renderWorkspaces(status) {
  const select = $("#workspaceSelect");
  if (!select) return;
  const list = status.workspaces || [];
  const activeId = status.activeWorkspace?.id;
  select.innerHTML = "";
  for (const ws of list) {
    const opt = document.createElement("option");
    opt.value = ws.id;
    opt.textContent = ws.name;
    if (ws.id === activeId) opt.selected = true;
    select.append(opt);
  }
  select.onchange = async () => {
    try {
      await api("workspaces/active", {
        method: "POST",
        body: { workspaceId: select.value, chatId: state.chatId || undefined },
      });
      await refreshStatus();
    } catch (error) {
      report(error);
    }
  };
}
async function refreshStatus() {
  try {
    const status = await api("status");
    hideAccessPending();
    state.status = status;
    state.token = status.token;
    if (status.user) {
      $("#profileName").textContent = status.user.display_name;
      $("#profileAvatar").textContent =
        status.user.display_name.trim().charAt(0).toUpperCase() || "?";
      renderAccountIdentity(status);
      renderWorkspaces(status);
      if (
        status.user.email_verification_required ||
        (status.user.email &&
          !status.user.email_verified &&
          status.user.role !== "owner")
      ) {
        location.assign("/verify");
        return;
      }
    }
    applyAppLanguage(status.preferences?.appLanguage ?? "en");
    if (!state.modeInitialized) {
      state.currentMode = status.preferences?.mode ?? "auto";
      state.taskMode = "auto";
      state.requestedModel = status.preferences?.model ?? "auto";
      state.modeInitialized = true;
      mountRoutingDropdowns();
    }
    if (status.jack) updateSelfModel(status.jack);
    const ready =
      !status.modelError &&
      status.models.some((m) => m.name === status.settings.model);
    $("#connectionDot").classList.toggle("ready", ready && !status.gaming);
    $("#connectionLabel").textContent = status.gaming
      ? tr("connection.gamingPriority")
      : ready
        ? tr("connection.local")
        : tr("connection.modelNotReady");
    renderProviders(status.providers, status);
    $("#gaming").classList.toggle("on", status.gaming);
    $("#gaming").setAttribute("aria-pressed", String(status.gaming));
    $("#gaming span").textContent = status.gaming
      ? tr("gaming.modeOn")
      : tr("gaming.mode");
    if (status.gaming)
      notice(
        tr("gaming.notice"),
      );
    else if (status.modelError)
      notice(
        tr("notice.engineOffline"),
      );
    else if (!ready)
      notice(
        tr("notice.modelMissing"),
      );
    else if (!state.busy) notice();
    if (status.approvals.length) showApproval(status.approvals[0]);
    return status;
  } catch (e) {
    $("#connectionLabel").textContent = tr("connection.disconnected");
    $("#connectionDot").classList.remove("ready");
    if (leavePublicAppForLogin(e)) return;
    if (e?.code === "pending_identity") {
      const email = e.email ? ` (${e.email})` : "";
      showAccessPending(tr("access.pendingBody") + email);
    }
  }
}
async function history() {
  const chats = await api("chats");
  $("#history").innerHTML = "";
  if (!chats.length)
    $("#history").innerHTML = `<div class="empty">${escape(tr("chat.historyEmpty")).replace("\n", "<br>")}</div>`;
  for (const chat of chats) {
    const row = document.createElement("div");
    row.className =
      "history-row" + (chat.id === state.chatId ? " selected" : "");
    const open = document.createElement("button");
    open.className = "history-item";
    open.textContent = chat.title;
    open.title = chat.title;
    open.onclick = async () => {
      if (state.busy) return notice(tr("chat.stopFirst"));
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
    del.title = tr("chat.deleteChat");
    del.onclick = async () => {
      if (state.busy) return;
      if (!confirm(tr("chat.deleteConfirm"))) return;
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
  if (state.busy) return notice(tr("chat.stopFirst"));
  state.chatId = null;
  state.attachments = [];
  state.currentMode = state.status?.preferences?.mode ?? "auto";
  state.taskMode = "auto";
  state.requestedModel = state.status?.preferences?.model ?? "auto";
  dropdowns.currentMode?.setValue(state.currentMode);
  dropdowns.taskMode?.setValue(state.taskMode);
  dropdowns.requestedModel?.setValue(state.requestedModel);
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
    copy.textContent = tr("chat.copyReply");
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
  $("#pageTitle").textContent = tr(`page.${name}`);
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
function setComposerPlaceholder() {
  $("#prompt").placeholder = tr("composer.placeholder");
  $("#prompt").classList.toggle("placeholder-ltr", state.locale === "en");
}
function showApproval(event) {
  const el = $("#approval");
  el.classList.remove("hidden");
  const consequence = event.consequence
    ? `<p>${escape(event.consequence)}</p>`
    : "";
  el.innerHTML = `<h3>${escape(tr("approval.title", { name: event.name }))}</h3>${consequence}<pre>${escape(JSON.stringify(event.args, null, 2))}</pre><button class="primary" id="allowTool">${escape(tr("approval.allow"))}</button><button class="ghost" id="denyTool">${escape(tr("approval.deny"))}</button>`;
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
function renderMemoryAskCard(proposal) {
  const card = document.createElement("div");
  card.className = "memory-ask-card";
  card.dataset.proposalId = proposal.id;
  const body = document.createElement("div");
  body.className = "memory-ask-body";
  body.innerHTML = `<p class="memory-ask-label">${escape(tr("memory.ask.title"))}</p><p class="memory-ask-content">${escape(proposal.content)}</p>`;
  const editor = document.createElement("textarea");
  editor.className = "memory-ask-edit hidden";
  editor.rows = 3;
  editor.value = proposal.content;
  const actions = document.createElement("div");
  actions.className = "memory-ask-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary";
  save.textContent = tr("memory.ask.save");
  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "ghost";
  discard.textContent = tr("memory.ask.discard");
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "ghost";
  edit.textContent = tr("memory.ask.edit");
  const setBusy = (busy) => {
    save.disabled = busy;
    discard.disabled = busy;
    edit.disabled = busy;
  };
  const finish = (message) => {
    card.classList.add("resolved");
    actions.remove();
    editor.remove();
    body.querySelector(".memory-ask-content").textContent = message;
  };
  save.onclick = async () => {
    setBusy(true);
    try {
      const editing = !editor.classList.contains("hidden");
      await api("memory-proposals/" + proposal.id, {
        method: "POST",
        body: editing
          ? { action: "edit", content: editor.value }
          : { action: "save" },
      });
      finish(tr("memory.ask.saved"));
      if (state.view === "memory") loadMemories().catch(report);
      refreshStatus().catch(report);
    } catch (error) {
      report(error);
      setBusy(false);
    }
  };
  discard.onclick = async () => {
    setBusy(true);
    try {
      await api("memory-proposals/" + proposal.id, {
        method: "POST",
        body: { action: "discard" },
      });
      finish(tr("memory.ask.discarded"));
    } catch (error) {
      report(error);
      setBusy(false);
    }
  };
  edit.onclick = () => {
    editor.classList.remove("hidden");
    body.querySelector(".memory-ask-content")?.classList.add("hidden");
    editor.focus();
    edit.classList.add("hidden");
  };
  actions.append(save, discard, edit);
  card.append(body, editor, actions);
  return card;
}
function renderSelfRepairCard(item) {
  if (item?.kind === "diagnosis" || item?.diagnosisOnly) {
    return renderSelfRepairDiagnosisCard(item);
  }
  return renderSelfRepairProposalCard(item);
}

function renderSelfRepairDiagnosisCard(diagnosis) {
  const card = document.createElement("div");
  card.className = "self-repair-card memory-ask-card self-repair-diagnosis";
  card.dataset.proposalId = diagnosis.id;
  card.dataset.kind = "diagnosis";
  const body = document.createElement("div");
  body.className = "memory-ask-body";
  const checks = (diagnosis.checksPerformed || [])
    .map(
      (c) =>
        `<li><code>${escape(c.id || "")}</code> · ${escape(c.status || "")}${c.detail ? ` — ${escape(c.detail)}` : ""}</li>`,
    )
    .join("");
  const findings = (diagnosis.findings || [])
    .map((f) => `<li>${escape(f.problem || f.rootCause || "")}</li>`)
    .join("");
  body.innerHTML = `
    <p class="memory-ask-label">${escape(tr("selfRepair.diagnosisTitle"))}</p>
    <p><strong>${escape(tr("selfRepair.status"))}:</strong> ${escape(tr("selfRepair.statusComplete"))}</p>
    <p><strong>${escape(tr("selfRepair.request"))}:</strong> ${escape(diagnosis.request || "")}</p>
    <p><strong>${escape(tr("selfRepair.checks"))}:</strong></p>
    <ul>${checks || `<li>${escape(tr("selfRepair.none"))}</li>`}</ul>
    <p><strong>${escape(tr("selfRepair.findings"))}:</strong> ${escape(diagnosis.summary || diagnosis.message || tr("selfRepair.noFault"))}</p>
    ${findings ? `<ul>${findings}</ul>` : ""}
    <p><strong>${escape(tr("selfRepair.confidence"))}:</strong> ${escape(diagnosis.confidence || "none")}</p>
  `;
  const details = document.createElement("pre");
  details.className = "self-repair-details hidden";
  details.textContent = JSON.stringify(
    { evidence: diagnosis.evidence || [], checks: diagnosis.checksPerformed || [] },
    null,
    2,
  );
  const actions = document.createElement("div");
  actions.className = "memory-ask-actions";
  const show = document.createElement("button");
  show.type = "button";
  show.className = "ghost";
  show.textContent = tr("selfRepair.details");
  show.onclick = () => details.classList.toggle("hidden");
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "ghost";
  dismiss.textContent = tr("selfRepair.cancel");
  dismiss.onclick = async () => {
    try {
      await api("self-repair/" + diagnosis.id, {
        method: "POST",
        body: { action: "cancel" },
      });
      card.classList.add("resolved");
      actions.remove();
      body.querySelector(".memory-ask-label").textContent = tr(
        "selfRepair.cancelled",
      );
      loadSelfRepairPanel().catch(report);
    } catch (error) {
      report(error);
    }
  };
  actions.append(show, dismiss);
  card.append(body, details, actions);
  return card;
}

function renderSelfRepairProposalCard(proposal) {
  const card = document.createElement("div");
  card.className = "self-repair-card memory-ask-card";
  card.dataset.proposalId = proposal.id;
  card.dataset.kind = "proposal";
  const canApplyRole = state.status?.selfRepair?.canApply === true;
  const hasPatches = Boolean(proposal.patches?.length);
  const showApply = canApplyRole && hasPatches;
  const body = document.createElement("div");
  body.className = "memory-ask-body";
  const files = (proposal.files || [])
    .map((f) => `<li><code>${escape(f)}</code></li>`)
    .join("");
  const plan = (proposal.plan || [])
    .map((step, i) => `<li>${escape(`${i + 1}. ${step}`)}</li>`)
    .join("");
  body.innerHTML = `
    <p class="memory-ask-label">${escape(tr("selfRepair.proposalTitle"))}</p>
    <p><strong>${escape(tr("selfRepair.problem"))}:</strong> ${escape(proposal.problem || "")}</p>
    <p><strong>${escape(tr("selfRepair.rootCause"))}:</strong> ${escape(proposal.rootCause || "")}</p>
    <p><strong>${escape(tr("selfRepair.files"))}:</strong></p>
    <ul>${files || `<li>${escape(tr("selfRepair.none"))}</li>`}</ul>
    <p><strong>${escape(tr("selfRepair.plan"))}:</strong></p>
    <ol class="self-repair-plan">${plan || `<li>${escape(tr("selfRepair.none"))}</li>`}</ol>
    <p><strong>${escape(tr("selfRepair.risk"))}:</strong> ${escape(proposal.risk || "low")}</p>
    ${
      proposal.securitySensitive
        ? `<p class="self-repair-security">${escape(tr("selfRepair.security"))}</p>`
        : ""
    }
    ${
      !hasPatches
        ? `<p class="hint">${escape(tr("selfRepair.awaitingPatch"))}</p>`
        : ""
    }
  `;
  const details = document.createElement("pre");
  details.className = "self-repair-details hidden";
  details.textContent = JSON.stringify(
    {
      evidence: proposal.evidence || [],
      patches: (proposal.patches || []).map((p) => p.path),
      findings: proposal.findings || [],
    },
    null,
    2,
  );
  const actions = document.createElement("div");
  actions.className = "memory-ask-actions";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "primary";
  apply.textContent = tr("selfRepair.apply");
  apply.disabled = !showApply;
  if (!canApplyRole) apply.title = tr("selfRepair.denied");
  else if (!hasPatches) apply.title = tr("selfRepair.noPatches");
  const show = document.createElement("button");
  show.type = "button";
  show.className = "ghost";
  show.textContent = tr("selfRepair.details");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.textContent = tr("selfRepair.cancel");
  let ack = null;
  if (proposal.securitySensitive && showApply) {
    ack = document.createElement("label");
    ack.className = "toggle-row";
    ack.innerHTML = `<input type="checkbox" class="self-repair-ack" /><span>${escape(tr("selfRepair.ackSecurity"))}</span>`;
    card.append(ack);
  }
  const finish = (message) => {
    card.classList.add("resolved");
    actions.remove();
    ack?.remove();
    details.remove();
    body.querySelector(".memory-ask-label").textContent = message;
  };
  apply.onclick = async () => {
    if (!showApply) return notice(tr("selfRepair.noPatches"));
    if (proposal.securitySensitive) {
      const checked = card.querySelector(".self-repair-ack")?.checked;
      if (!checked) return notice(tr("selfRepair.ackSecurity"));
    }
    apply.disabled = true;
    cancel.disabled = true;
    try {
      const result = await api("self-repair/" + proposal.id, {
        method: "POST",
        body: {
          action: "apply",
          acknowledgeSecurity: Boolean(
            card.querySelector(".self-repair-ack")?.checked,
          ),
        },
      });
      finish(
        result.ok ? tr("selfRepair.applied") : tr("selfRepair.reverted"),
      );
      loadSelfRepairPanel().catch(report);
    } catch (error) {
      report(error);
      apply.disabled = false;
      cancel.disabled = false;
    }
  };
  show.onclick = () => details.classList.toggle("hidden");
  cancel.onclick = async () => {
    cancel.disabled = true;
    try {
      await api("self-repair/" + proposal.id, {
        method: "POST",
        body: { action: "cancel" },
      });
      finish(tr("selfRepair.cancelled"));
      loadSelfRepairPanel().catch(report);
    } catch (error) {
      report(error);
      cancel.disabled = false;
    }
  };
  if (showApply) actions.append(apply);
  actions.append(show, cancel);
  card.append(body, details, actions);
  return card;
}
async function loadSelfRepairPanel() {
  const section = $("#selfRepairSection");
  if (!section) return;
  const owner = state.status?.user?.role === "owner";
  section.classList.toggle("hidden", !owner);
  if (!owner) return;
  try {
    const data = await api("self-repair");
    $("#selfRepairEnabled").checked = data.settings?.enabled !== false;
    $("#selfRepairAutoDiagnose").checked = data.settings?.autoDiagnose !== false;
    const host = $("#selfRepairHistory");
    host.innerHTML = "";
    const rows = data.history || [];
    if (!rows.length) {
      host.textContent = tr("selfRepair.historyEmpty");
      return;
    }
    for (const row of rows.slice(0, 20)) {
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = `<p><strong>${escape(row.timestamp || "")}</strong> · ${escape(row.result || "")}</p>
        <p>${escape(row.issue || "")}</p>
        <p class="hint">${escape(row.diagnosis || "").slice(0, 280)}</p>
        <p class="hint">${escape((row.filesChanged || []).join(", ") || "—")}</p>`;
      host.append(el);
    }
  } catch (error) {
    report(error);
  }
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
  thinking.innerHTML = `<i></i><i></i><i></i><span>${escape(tr("composer.thinking"))}</span>`;
  answer.append(thinking);
  let full = "";
  let accepted = false;
  const steps = [];
  $("#runStatus").textContent = tr("composer.status.thinking");
  window.__cjTiming = { sendAt: performance.now() };
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({
        text,
        chatId: state.chatId,
        mode: state.taskMode || dropdowns.taskMode?.getValue() || "auto",
        requestedMode: state.currentMode || "auto",
        requestedModel: state.requestedModel || "auto",
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
          if (!content.dataset.firstPaint) {
            content.dataset.firstPaint = String(performance.now());
            if (window.__cjTiming) {
              window.__cjTiming.browser_first_chunk_ms =
                performance.now() - (window.__cjTiming.sendAt || 0);
              window.__cjTiming.browser_first_paint_ms =
                window.__cjTiming.browser_first_chunk_ms;
            }
          }
          renderText(content, full, { streaming: true });
          $("#runStatus").textContent = tr("composer.status.streaming");
        }
        if (item.type === "revise") {
          thinking.remove();
          full = item.text || "";
          renderText(content, full, { streaming: true });
        }
        if (item.type === "routing") {
          // Routing stays internal — no composer chips or exec-meta in the chat UI.
        }
        if (item.type === "council") {
          if (!shouldShowCouncilInChat(item)) continue;
          const el = document.createElement("details");
          el.className = "tool-step council-step";
          const ok = item.status === "done";
          const title = item.title || "AI Council";
          el.innerHTML = `<summary>${ok ? "✓" : "◌"} ${escape(title)} · ${escape(item.detail || item.status || "")}</summary>`;
          if (item.evidenceTypes?.length || item.verification) {
            const meta = document.createElement("div");
            meta.className = "council-summary";
            meta.textContent = [
              item.evidenceTypes?.length
                ? `Evidence: ${item.evidenceTypes.join(", ")}`
                : "",
              item.verification ? `Verification: ${item.verification}` : "",
              item.testsVerified != null
                ? `Tests verified: ${item.testsVerified ? "yes" : "no"}`
                : "",
            ]
              .filter(Boolean)
              .join(" · ");
            el.append(meta);
          }
          if (item.proposals?.length) {
            const list = document.createElement("ul");
            for (const p of item.proposals) {
              const row = document.createElement("li");
              const latency =
                p.latencyMs != null ? ` · ${p.latencyMs}ms` : "";
              row.textContent = `${(p.role || "").toUpperCase()}: ${p.provider}/${p.model} · ${p.status}${latency}`;
              if (p.summary) {
                const note = document.createElement("div");
                note.className = "council-summary";
                note.textContent = p.summary.slice(0, 280);
                row.append(note);
              }
              list.append(row);
            }
            el.append(list);
          }
          answer.append(el);
        }
        if (item.type === "round")
          $("#runStatus").textContent = tr("composer.status.working", {
            round: item.round,
          });
        if (item.type === "tool") {
          if (!shouldShowToolInChat(item)) continue;
          thinking.remove();
          let el;
          if (item.status === "running") {
            el = document.createElement("details");
            el.className = "tool-step";
            el.dataset.name = item.name;
            el.innerHTML = `<summary>◌ ${escape(item.name)} · ${escape(tr("tool.running"))}</summary><pre>${escape(JSON.stringify(item.args, null, 2))}</pre>`;
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
                `${item.status === "error" ? "!" : "✓"} ${item.name} · ${item.status === "error" ? tr("tool.error") : tr("tool.done")}`;
              const pre = el.querySelector("pre");
              const sources =
                item.name === "research"
                  ? (item.result?.sources ?? item.result?.results ?? []).filter(
                      (source) => source?.url,
                    )
                  : [];
              if (item.name === "research" && item.status !== "error") {
                el.querySelector("summary").textContent =
                  `Research ✓ · ${sources.length} sources`;
                pre.remove();
                const list = document.createElement("ul");
                list.className = "research-sources";
                for (const source of sources.slice(0, 5)) {
                  const row = document.createElement("li");
                  const link = document.createElement("a");
                  link.href = source.url;
                  link.target = "_blank";
                  link.rel = "noopener noreferrer";
                  link.textContent = source.title || source.url;
                  row.append(link);
                  list.append(row);
                }
                el.append(list);
              } else if (pre) {
                pre.textContent = JSON.stringify(item.result, null, 2);
              }
              if (
                item.result?.image &&
                /^\/artifacts\/[a-z]+-\d+\.png$/.test(item.result.image)
              ) {
                const img = document.createElement("img");
                img.src = item.result.image;
                img.alt = tr("tool.screenshotAlt");
                el.append(img);
              }
            } else if (item.status === "done" || item.status === "error") {
              // Done arrived without a visible running card — show final card.
              el = document.createElement("details");
              el.className = "tool-step";
              el.dataset.name = item.name;
              el.dataset.done = "1";
              el.classList.toggle("error", item.status === "error");
              el.innerHTML = `<summary>${item.status === "error" ? "!" : "✓"} ${escape(item.name)} · ${escape(item.status === "error" ? tr("tool.error") : tr("tool.done"))}</summary><pre>${escape(JSON.stringify(item.result, null, 2))}</pre>`;
              answer.append(el);
            }
          }
        }
        if (item.type === "memory") {
          thinking.remove();
          for (const proposal of item.pending ?? []) {
            if (!proposal?.id) continue;
            answer.append(renderMemoryAskCard(proposal));
          }
        }
        if (item.type === "self_repair") {
          thinking.remove();
          const payload = item.diagnosis || item.proposal;
          if (payload) answer.append(renderSelfRepairCard(payload));
        }
        if (item.type === "approval") showApproval(item);
        if (item.type === "error") {
          failed = true;
          notice(item.error);
          if (!full) content.textContent = item.error;
          content.classList.add("error-text");
        }
        if (item.type === "done") {
          if (full) renderText(content, full, { streaming: false });
          $("#runStatus").textContent = tr("composer.status.done");
        }
        if (item.type === "timing" && window.__cjTiming) {
          Object.assign(window.__cjTiming, item);
        }
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
  if (!e.target.closest("button, a")) $("#prompt").focus();
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
      state.taskMode = button.dataset.mode || "auto";
      dropdowns.taskMode?.setValue(state.taskMode);
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
      throw new Error(tr("notice.uploadMaxSize"));
    if (state.attachments.length >= 5)
      throw new Error(tr("notice.uploadMaxCount"));
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
  const query = $("#memorySearch")?.value.trim() ?? "";
  const memories = await api(`memories?q=${encodeURIComponent(query)}`);
  $("#memories").innerHTML = "";
  if (!memories.length)
    $("#memories").innerHTML = `<div class="empty">${escape(tr("memory.empty"))}</div>`;
  const categories = [
    ["Preferences", "memory.preferences"],
    ["About Me", "memory.aboutMe"],
    ["Environment", "memory.environment"],
    ["Projects", "memory.projects"],
    ["Lessons", "memory.lessons"],
  ];
  for (const [category, key] of categories) {
    const items = memories.filter(
      (memory) =>
        (memory.category || "About Me").toLowerCase() ===
        category.toLowerCase(),
    );
    if (!items.length) continue;
    const group = document.createElement("section");
    group.className = "memory-category";
    const heading = document.createElement("h3");
    heading.textContent = tr(key);
    group.append(heading);
    for (const m of items) {
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = `<small>${escape(tr(`memory.kind.${m.kind}`))} · ${new Date(m.created).toLocaleDateString(state.locale === "ar" ? "ar-SA" : "en-US")}</small><p>${escape(m.content)}</p>`;
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "ghost";
      edit.textContent = state.locale === "ar" ? "تعديل" : "Edit";
      edit.onclick = async () => {
        const content = prompt(
          state.locale === "ar" ? "عدّل الذاكرة" : "Edit memory",
          m.content,
        )?.trim();
        if (!content || content === m.content) return;
        await api("memories/" + m.id, { method: "DELETE" });
        await api("memories", {
          method: "POST",
          body: { content, kind: m.kind },
        });
        await loadMemories();
      };
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "delete";
      remove.textContent = "×";
      remove.setAttribute("aria-label", tr("memory.deleteAria"));
      remove.onclick = async () => {
        await api("memories/" + m.id, { method: "DELETE" });
        await loadMemories();
      };
      el.append(edit, remove);
      group.append(el);
    }
    $("#memories").append(group);
  }
}
$("#memorySearch").oninput = () => loadMemories().catch(report);
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
    : `<div class="empty">${escape(tr("activity.empty"))}</div>`;
  for (const item of events) {
    const el = document.createElement("details");
    el.className = "card";
    el.innerHTML = `<summary>${item.status === "done" ? "✓" : "!"} ${escape(item.tool)} <small> · ${new Date(item.created).toLocaleString(state.locale === "ar" ? "ar-SA" : "en-US")}</small></summary><pre>${escape(JSON.stringify(JSON.parse(item.detail), null, 2))}</pre>`;
    $("#events").append(el);
  }
}
$("#refreshEvents").onclick = () => loadEvents().catch(report);
async function loadSettings() {
  const status = await refreshStatus();
  if (!status) return;
  await loadPreferences();
  await loadUsers();
  const form = $("#settingsForm");
  for (const [name, host] of [
    ["model", "#modelSelectHost"],
    ["codingModel", "#codingModelHost"],
    ["visionModel", "#visionModelHost"],
  ]) {
    const names = [
      ...new Set(
        [
          ...status.models.map((m) => m.name),
          status.settings[name],
        ].filter(Boolean),
      ),
    ];
    dropdowns.settingsModels[name] = mountDropdown(host, {
      name,
      options: [
        ...(name === "model"
          ? [{ value: "auto", label: "Auto" }]
          : [{ value: "", label: tr("settings.sameAsPrimary") }]),
        ...names
          .filter((value) => value && value !== "auto")
          .map((value) => ({ value, label: value })),
      ],
      value: status.settings[name] || (name === "model" ? "auto" : ""),
      ariaLabel: tr(
        name === "model"
          ? "settings.primaryModel"
          : name === "codingModel"
            ? "settings.codingModel"
            : "settings.visionModel",
      ),
    });
  }
  for (const key of ["workspace", "instructions"])
    form.elements[key].value = status.settings[key];
  for (const key of ["autoApprove", "autoGaming"])
    form.elements[key].checked = status.settings[key];
  form.elements.gameProcesses.value = status.settings.gameProcesses.join(", ");
  mountRoutingDropdowns();
}
async function switchUser(userId) {
  if (state.status?.identitySource !== "local")
    throw new Error(tr("users.remoteSwitchHelp"));
  if (state.busy) throw new Error(tr("chat.stopFirst"));
  const result = await api("session/switch", {
    method: "POST",
    body: { userId },
  });
  state.token = result.token;
  state.chatId = null;
  state.modeInitialized = false;
  state.status = null;
  state.attachments = [];
  $("#messages").innerHTML = "";
  $("#welcome").classList.remove("hidden");
  const wsSelect = $("#workspaceSelect");
  if (wsSelect) wsSelect.innerHTML = "";
  await refreshStatus();
  await Promise.all([history(), loadPreferences()]);
  if (state.view === "settings") await loadUsers();
}
async function loadUsers() {
  const users = await api("users");
  const current = state.status?.user;
  if (!current) return;
  $("#currentUser").textContent = `${current.display_name} · ${current.role}`;
  const owner = current.role === "owner";
  $("#createUserForm").classList.toggle("hidden", !owner);
  const ownerForm = $("#ownerCredentialsForm");
  if (ownerForm) {
    ownerForm.classList.toggle("hidden", !owner);
    if (owner && current.email && !ownerForm.elements.email.value)
      ownerForm.elements.email.value = current.email;
  }
  $("#selfRepairSection")?.classList.toggle("hidden", !owner);
  if (owner) loadSelfRepairPanel().catch(report);
  $("#usersList").innerHTML = "";
  const localSession = state.status?.identitySource === "local";
  if (owner && !localSession) {
    const help = document.createElement("p");
    help.id = "remoteSwitchHelp";
    help.className = "hint";
    help.textContent = tr("users.remoteSwitchHelp");
    $("#usersList").append(help);
  }
  for (const user of users) {
    const row = document.createElement("div");
    row.className = "card";
    const label = document.createElement("p");
    const ids = user.identities || [];
    const hasCf = ids.some((i) => i.provider === "cloudflare_access");
    const identityNote = hasCf
      ? tr("account.linkedCloudflare")
      : tr("account.localOnly");
    label.textContent = `${user.display_name} · ${user.role} · ${user.status} · ${identityNote}`;
    row.append(label);
    if (owner && user.status === "active" && user.id !== current.id) {
      const use = document.createElement("button");
      use.type = "button";
      use.className = "ghost";
      use.textContent = tr("users.switch");
      // Keep clickable remotely so the notice explains the block (disabled
      // buttons look broken / do nothing). Switching remains local-only.
      if (!localSession) {
        use.title = tr("users.remoteSwitchHelp");
        use.setAttribute("aria-disabled", "true");
        use.setAttribute("aria-describedby", "remoteSwitchHelp");
      }
      use.onclick = () => switchUser(user.id).catch(report);
      row.append(use);
    }
    if (owner) {
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "ghost";
      rename.textContent = tr("users.rename");
      rename.onclick = async () => {
        const displayName = prompt(tr("users.name"), user.display_name)?.trim();
        if (!displayName || displayName === user.display_name) return;
        await api("users/" + user.id, {
          method: "PATCH",
          body: { displayName },
        });
        await loadUsers();
      };
      row.append(rename);
      if (user.status === "active" && user.id !== current.id) {
        const disable = document.createElement("button");
        disable.type = "button";
        disable.className = "delete";
        disable.textContent = tr("users.disable");
        disable.onclick = async () => {
          if (!confirm(tr("users.disableConfirm"))) return;
          await api("users/" + user.id, {
            method: "PATCH",
            body: { status: "disabled" },
          });
          await loadUsers();
        };
        row.append(disable);
      }
    }
    $("#usersList").append(row);
  }
}
$("#createUserForm").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const role = form.elements.namedItem("role").value;
  const confirmOwner = role === "owner" && confirm(
    "Create an Owner with full user-management and system permissions?",
  );
  if (role === "owner" && !confirmOwner) return;
  await api("users", {
    method: "POST",
    body: {
      displayName: form.elements.displayName.value,
      role,
      confirmOwner,
    },
  });
  form.reset();
  await loadUsers();
};
$("#ownerCredentialsForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const message = $("#ownerCredentialsMessage");
  if (message) message.textContent = "";
  try {
    const data = await api("auth/owner/credentials", {
      method: "POST",
      body: {
        email: form.elements.email.value,
        password: form.elements.password.value,
        confirmPassword: form.elements.confirmPassword.value,
      },
    });
    form.elements.password.value = "";
    form.elements.confirmPassword.value = "";
    if (message) message.textContent = data.user?.email || "Saved";
    await refreshStatus();
    await loadUsers();
  } catch (error) {
    if (message) message.textContent = error.message;
  }
});
$("#settingsForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("settings", {
      method: "POST",
      body: {
        model: dropdowns.settingsModels.model.getValue(),
        codingModel: dropdowns.settingsModels.codingModel.getValue(),
        visionModel: dropdowns.settingsModels.visionModel.getValue(),
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
    $("#settingsMessage").textContent = tr("settings.saved");
    await refreshStatus();
  } catch (err) {
    $("#settingsMessage").textContent = err.message;
  }
};
$("#selfRepairSave")?.addEventListener("click", async () => {
  try {
    await api("self-repair", {
      method: "POST",
      body: {
        enabled: $("#selfRepairEnabled").checked,
        autoDiagnose: $("#selfRepairAutoDiagnose").checked,
        askBeforeModify: "always",
      },
    });
    $("#selfRepairMessage").textContent = tr("selfRepair.saved");
    await loadSelfRepairPanel();
  } catch (err) {
    $("#selfRepairMessage").textContent = err.message;
  }
});
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
  return Object.fromEntries(
    ["language", "dialect", "humor", "detail"].map((key) => [
      key,
      dropdowns.persona[key]?.getValue() ?? "auto",
    ]),
  );
}
function mountPersonaDropdowns(values = {}) {
  const definitions = {
    language: {
      host: "#personaLanguageHost",
      aria: "persona.replyLanguage",
      options: ["auto", "ar", "en"].map((value) => ({
        value,
        label:
          value === "auto"
            ? tr("lang.autoAssistant")
            : tr(`lang.${value}`),
      })),
    },
    dialect: {
      host: "#personaDialectHost",
      aria: "persona.dialect",
      options: ["jeddah", "standard"].map((value) => ({
        value,
        label: tr(`persona.dialect.${value}`),
      })),
    },
    humor: {
      host: "#personaHumorHost",
      aria: "persona.humor",
      options: ["playful", "subtle", "off"].map((value) => ({
        value,
        label: tr(`persona.humor.${value}`),
      })),
    },
    detail: {
      host: "#personaDetailHost",
      aria: "persona.detail",
      options: ["concise", "balanced", "thorough"].map((value) => ({
        value,
        label: tr(`persona.detail.${value}`),
      })),
    },
  };
  for (const [key, definition] of Object.entries(definitions)) {
    dropdowns.persona[key] = mountDropdown(definition.host, {
      name: key,
      options: definition.options,
      value: values[key] ?? dropdowns.persona[key]?.getValue(),
      ariaLabel: tr(definition.aria),
      onChange: () => {
        previewPersona();
        $("#personaMessage").textContent = tr("persona.savePrompt");
      },
    });
  }
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
  const formatter = new Intl.NumberFormat(state.locale === "ar" ? "ar-SA" : "en-US");
  $("#memoryCount").textContent = formatter.format(jack.memories);
  $("#conversationCount").textContent = formatter.format(jack.conversations);
  $("#toolCount").textContent = formatter.format(jack.completedTools);
  $("#selfState").textContent = tr(
    `persona.self.state.${jack.state === "gaming" ? "gaming" : jack.state === "working" ? "working" : "ready"}`,
  );
  $("#jackPresence").textContent =
    jack.state === "gaming"
      ? tr("welcome.presence.gaming")
      : jack.state === "working"
        ? tr("welcome.presence.working")
        : tr("welcome.presence.here");
  $("#personalityShortcut").textContent = tr(
    `persona.shortcut.${jack.persona.humor}`,
  );
  const r = jack.lastReflection;
  if (r) {
    const outcome = r.outcome === "step-limit" ? "stepLimit" : r.outcome;
    const result = tr(`persona.self.outcome.${outcome}`);
    $("#lastReflection").textContent = tr("persona.self.reflection", {
      result,
      successfulTools: r.successfulTools,
      failedTools: r.failedTools,
      durationSeconds: r.durationSeconds,
    });
  } else
    $("#lastReflection").textContent = tr("persona.self.reflectionEmpty");
}
async function loadPersona() {
  const jack = await api("persona");
  mountPersonaDropdowns(jack.persona);
  $("#personaMessage").textContent = "";
  updateSelfModel(jack);
  previewPersona();
}
for (const button of document.querySelectorAll("[data-persona-preset]"))
  button.onclick = () => {
    for (const [key, value] of Object.entries(
      presets[button.dataset.personaPreset],
    ))
      dropdowns.persona[key]?.setValue(value);
    previewPersona();
    $("#personaMessage").textContent = tr("persona.savePrompt");
  };
$("#personaForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const jack = await api("persona", {
      method: "POST",
      body: personaValues(),
    });
    updateSelfModel(jack);
    $("#personaMessage").textContent = tr("persona.saved");
  } catch (error) {
    $("#personaMessage").textContent = error.message;
  }
};
let preferenceCatalog;
async function loadPreferences() {
  const data = await api("preferences");
  preferenceCatalog = data.catalog;
  const form = $("#preferenceForm");
  form.innerHTML = "";
  const sections = [
    [
      "settings.section.general",
      [
        "appLanguage",
        "language",
        "memoryBehavior",
        "model",
        "address",
        "name",
        "customAddress",
      ],
    ],
    [
      "settings.section.personality",
      ["tone", "verbosity", "humor", "initiative"],
    ],
    ["settings.section.modes", ["mode"]],
    [
      "settings.section.aiProviders",
      [
        "councilMode",
        "remoteAi",
        "councilMaxModels",
        "remoteBudget",
        "councilOtherModels",
      ],
    ],
  ];
  const labelKeys = {
    appLanguage: "settings.appLanguage",
    language: "settings.assistantLanguage",
    memoryBehavior: "settings.memoryBehavior",
    model: "settings.autoModel",
    address: "settings.address",
    name: "settings.name",
    customAddress: "settings.customAddress",
    tone: "settings.tone",
    verbosity: "settings.verbosity",
    humor: "settings.humorPref",
    initiative: "settings.initiative",
    mode: "settings.defaultMode",
    councilMode: "settings.councilMode",
    remoteAi: "settings.remoteAi",
    councilMaxModels: "settings.councilMaxModels",
    remoteBudget: "settings.remoteBudget",
    councilOtherModels: "settings.councilOtherModels",
  };
  const preferenceDropdowns = {};
  let custom = data.preferences.capabilities !== null;
  let drawPacks = () => {};
  const optionsFor = (key) => {
    if (key === "appLanguage")
      return data.catalog.options[key].map((value) => ({
        value,
        label: tr(`lang.${value}`),
      }));
    if (key === "language")
      return data.catalog.options[key].map((value) => ({
        value,
        label:
          value === "auto" ? tr("lang.autoAssistant") : tr(`lang.${value}`),
      }));
    if (key === "mode") return modeOptions();
    if (key === "model") {
      const installed = state.status?.models ?? [];
      return [
        { value: "auto", label: tr("settings.autoModel") },
        ...installed.map((item) => ({
          value: item.name,
          label:
            item.label ||
            `${item.name} · ${item.provider || "Ollama"} · ${item.local === false ? tr("composer.modelRemote") : tr("composer.modelLocal")}`,
        })),
      ];
    }
    if (
      ["councilMode", "remoteAi", "councilMaxModels", "remoteBudget", "councilOtherModels"].includes(
        key,
      )
    )
      return data.catalog.options[key].map((value) => ({
        value,
        label: tr(`${key}.${value}`),
      }));
    return data.catalog.options[key].map((value) => ({
      value,
      label: tr(
        key === "memoryBehavior"
          ? `memoryBehavior.${value}`
          : key === "address"
            ? `address.${value}`
            : key === "tone"
              ? `tone.${value}`
              : key === "verbosity"
                ? `verbosity.${value}`
                : key === "humor"
                  ? `humorPref.${value}`
                  : `initiative.${value}`,
      ),
    }));
  };
  for (const [headingKey, keys] of sections) {
    const card = document.createElement("div");
    card.className = "setting-card";
    const heading = document.createElement("h3");
    heading.textContent = tr(headingKey);
    card.append(heading);
    for (const key of keys) {
      const label = document.createElement("label");
      const caption = document.createElement("span");
      caption.textContent = tr(labelKeys[key]);
      label.append(caption);
      if (["name", "customAddress"].includes(key)) {
        const input = document.createElement("input");
        input.name = key;
        input.maxLength = 40;
        input.dir = "auto";
        input.value = data.preferences[key];
        label.append(input);
      } else {
        const host = document.createElement("div");
        host.className = "dropdown-host";
        label.append(host);
        preferenceDropdowns[key] = createDropdown({
          name: key,
          options: optionsFor(key),
          value: data.preferences[key],
          ariaLabel: tr(labelKeys[key]),
          onChange: async (value) => {
            if (key === "mode") drawPacks();
            if (key === "appLanguage") {
              applyAppLanguage(value);
              try {
                await api("preferences", {
                  method: "POST",
                  body: { appLanguage: value },
                });
                if (state.status?.preferences)
                  state.status.preferences.appLanguage = value;
                await refreshStatus();
                await loadPreferences();
              } catch (error) {
                report(error);
              }
            }
          },
        });
        host.append(preferenceDropdowns[key]);
      }
      card.append(label);
    }
    if (keys.includes("mode")) {
      const hint = document.createElement("p");
      hint.id = "modeDescription";
      hint.className = "hint";
      card.append(hint);
    }
    form.append(card);
  }
  const card = document.createElement("div");
  card.className = "setting-card";
  card.innerHTML = `<h3>${escape(tr("settings.section.capabilities"))}</h3><p class="hint">${escape(tr("settings.capabilitiesHint"))}</p><div id="capabilityChoices"></div><button type="button" id="resetCapabilities" class="ghost">${escape(tr("settings.resetCapabilities"))}</button>`;
  form.append(card);
  drawPacks = () => {
    const mode = preferenceDropdowns.mode.getValue();
    $("#modeDescription").textContent = tr(`mode.${mode}.description`);
    const packs = custom
      ? data.preferences.capabilities
      : data.catalog.modes[mode].packs;
    $("#capabilityChoices").innerHTML = "";
    for (const key of Object.keys(data.catalog.packs)) {
      const label = document.createElement("label");
      label.className = "toggle-row";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "pack";
      input.value = key;
      input.checked = packs.includes(key);
      input.onchange = () => {
        custom = true;
        data.preferences.capabilities = [
          ...form.querySelectorAll('[name="pack"]:checked'),
        ].map((node) => node.value);
      };
      label.append(input, document.createTextNode(tr(`pack.${key}`)));
      $("#capabilityChoices").append(label);
    }
  };
  $("#resetCapabilities").onclick = () => {
    custom = false;
    drawPacks();
  };
  drawPacks();
  const footer = document.createElement("div");
  footer.className = "settings-footer";
  footer.innerHTML = `<button class="primary">${escape(tr("settings.savePreferences"))}</button><span id="preferenceMessage" role="status"></span>`;
  form.append(footer);
  form.onsubmit = async (event) => {
    event.preventDefault();
    try {
      const values = {};
      for (const [, keys] of sections)
        for (const key of keys)
          values[key] =
            preferenceDropdowns[key]?.getValue() ?? form.elements[key].value;
      values.capabilities = custom
        ? [...form.querySelectorAll('[name="pack"]:checked')].map(
            (node) => node.value,
          )
        : null;
      await api("preferences", { method: "POST", body: values });
      $("#preferenceMessage").textContent = tr("settings.preferencesSaved");
      if (state.status) state.status.preferences = { ...data.preferences, ...values };
      await refreshStatus();
    } catch (error) {
      $("#preferenceMessage").textContent = error.message;
    }
  };
}

$("#accountLogout")?.addEventListener("click", async () => {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: sessionHeaders(),
    });
  } finally {
    location.assign("/login");
  }
});

applyAppLanguage("en");
await refreshStatus();
if (!publicLoginRedirect) {
  await loadPreferences().catch(report);
  await history().catch(report);
  syncComposer();
  setInterval(refreshStatus, 15000);
}
