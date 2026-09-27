import { mountBranding } from "/branding.js";
import {
  applyDocumentLocale,
  applyStaticI18n,
  readAppLanguageHint,
  resolveAppLocale,
  t,
} from "/i18n.js";

mountBranding();

const locale = resolveAppLocale(readAppLanguageHint());
applyDocumentLocale(locale);
applyStaticI18n(document, locale.lang);
document.title = t("page.authTitle", locale.lang);
const tr = (key) => t(key, locale.lang);

const page = location.pathname.replace(/\/$/, "") || "/login";
const form = document.querySelector("#authForm");
const title = document.querySelector("#authTitle");
const lead = document.querySelector("#authLead");
const submit = document.querySelector("#authSubmit");
const errorEl = document.querySelector("#authError");
const noteEl = document.querySelector("#authNote");

const copy = {
  "/login": {
    title: tr("auth.signIn"),
    lead: tr("auth.lead.login"),
    submit: tr("auth.submit.login"),
    password: "current-password",
  },
  "/signup": {
    title: tr("auth.createAccount"),
    lead: tr("auth.lead.signup"),
    submit: tr("auth.submit.signup"),
    password: "new-password",
  },
  "/forgot": {
    title: tr("auth.forgot"),
    lead: tr("auth.lead.forgot"),
    submit: tr("auth.submit.forgot"),
  },
  "/reset": {
    title: tr("auth.reset"),
    lead: tr("auth.lead.reset"),
    submit: tr("auth.submit.reset"),
    password: "new-password",
    tokenLabel: tr("auth.code.reset"),
  },
  "/verify": {
    title: tr("auth.verify"),
    lead: tr("auth.lead.verify"),
    submit: tr("auth.submit.verify"),
    tokenLabel: tr("auth.code.verify"),
  },
}[page] || {
  title: tr("auth.signIn"),
  lead: "",
  submit: tr("auth.submit.login"),
};

title.textContent = copy.title;
lead.textContent = copy.lead;
submit.textContent = copy.submit;
document.querySelector("#nameRow").classList.toggle("hidden", page !== "/signup");
document.querySelector("#emailRow").classList.toggle("hidden", page === "/verify");
document.querySelector("#confirmRow").classList.toggle(
  "hidden",
  page !== "/signup" && page !== "/reset",
);
document.querySelector("#passwordRow").classList.toggle(
  "hidden",
  page === "/forgot" || page === "/verify",
);
document.querySelector("#tokenRow").classList.toggle(
  "hidden",
  page !== "/reset" && page !== "/verify",
);
if (copy.tokenLabel) {
  const tokenLabel = document.querySelector("#tokenLabel");
  if (tokenLabel) tokenLabel.textContent = copy.tokenLabel;
}
if (copy.password)
  form.elements.password?.setAttribute("autocomplete", copy.password);
if (form.elements.email) form.elements.email.required = page !== "/verify";
if (form.elements.password)
  form.elements.password.required = page !== "/forgot" && page !== "/verify";
const codeField = form.elements.code;
if (codeField) {
  const prefilled = sessionStorage.getItem("cj_dev_verify") || "";
  if (/^\d{6}$/.test(prefilled)) codeField.value = prefilled;
  sessionStorage.removeItem("cj_dev_verify");
}
const resendBtn = document.querySelector("#authResend");
if (resendBtn) resendBtn.classList.toggle("hidden", page !== "/verify");

function showError(text) {
  errorEl.hidden = !text;
  errorEl.textContent = text || "";
}
function showNote(text) {
  noteEl.hidden = !text;
  noteEl.textContent = text || "";
}
function sessionMessage(data, fallback) {
  if (data?.code === "session_expired") return tr("auth.sessionExpired");
  if (/invalid session token/i.test(data?.error || "")) return tr("auth.sessionExpired");
  return data?.error || fallback;
}
function mailNote(mail, extra) {
  if (mail && mail.configured === false) return tr("auth.mailUnconfigured");
  return extra || mail?.message || "";
}

async function authFetch(route, body) {
  const res = await fetch(route, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function loadMailConfig() {
  try {
    const res = await fetch("/api/auth/config", { credentials: "same-origin" });
    const data = await res.json();
    if (data.mail?.configured === false) showNote(tr("auth.mailUnconfigured"));
    return data;
  } catch {
    return null;
  }
}

async function recognizeVerifySession() {
  const res = await fetch("/api/auth/me", { credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showError(tr("auth.sessionExpired"));
    setTimeout(() => location.assign("/login"), 1600);
    return null;
  }
  if (data.user?.email_verified || !data.user?.email_verification_required) {
    location.assign("/");
    return data.user;
  }
  return data.user;
}

if (page === "/signup" || page === "/forgot" || page === "/verify" || page === "/reset")
  loadMailConfig();
if (page === "/verify") recognizeVerifySession();

resendBtn?.addEventListener("click", async () => {
  showError("");
  showNote("");
  resendBtn.disabled = true;
  try {
    const { res, data } = await authFetch("/api/auth/resend");
    if (!res.ok) {
      showError(sessionMessage(data, tr("auth.error.send")));
      if (data.code === "session_expired" || /invalid session token/i.test(data.error || ""))
        setTimeout(() => location.assign("/login"), 1600);
      return;
    }
    if (data.alreadyVerified) {
      location.assign("/");
      return;
    }
    showNote(mailNote(data.mail, data.mail?.message));
    if (/^\d{6}$/.test(data.devToken || "") && codeField)
      codeField.value = data.devToken;
  } catch (error) {
    showError(error.message);
  } finally {
    resendBtn.disabled = false;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  showNote("");
  submit.disabled = true;
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    if (page === "/signup") {
      const { res, data } = await authFetch("/api/auth/register", body);
      if (!res.ok) throw new Error(data.error || tr("auth.error.create"));
      if (/^\d{6}$/.test(data.devToken || ""))
        sessionStorage.setItem("cj_dev_verify", data.devToken);
      if (data.mail?.configured === false) showNote(tr("auth.mailUnconfigured"));
      location.assign("/verify");
      return;
    }
    if (page === "/login") {
      const { res, data } = await authFetch("/api/auth/login", {
        email: body.email,
        password: body.password,
      });
      if (!res.ok) throw new Error(data.error || tr("auth.error.signIn"));
      if (
        data.user?.role !== "owner" &&
        data.user?.email &&
        !data.user.email_verified
      )
        location.assign("/verify");
      else location.assign("/");
      return;
    }
    if (page === "/forgot") {
      const { res, data } = await authFetch("/api/auth/forgot", {
        email: body.email,
      });
      if (!res.ok) throw new Error(data.error || tr("auth.error.forgot"));
      showNote(mailNote(data.mail, data.message));
      return;
    }
    if (page === "/reset") {
      const { res, data } = await authFetch("/api/auth/reset", {
        email: body.email,
        code: body.code,
        password: body.password,
        confirmPassword: body.confirmPassword,
      });
      if (!res.ok) throw new Error(data.error || tr("auth.error.reset"));
      location.assign("/login");
      return;
    }
    if (page === "/verify") {
      const { res, data } = await authFetch("/api/auth/verify", {
        code: body.code,
      });
      if (!res.ok) {
        showError(sessionMessage(data, data.error || tr("auth.error.verify")));
        return;
      }
      location.assign("/");
    }
  } catch (error) {
    showError(error.message);
  } finally {
    submit.disabled = false;
  }
});
