// Client for the account pages (/signup, /login, /verify).
// The email verification input is ONLY the emailed code — never a session
// token, cookie, or CoffeeJack API token. The session travels in an httpOnly
// cookie set at signup/login, so nothing is ever typed or placed in the URL.

const $ = (selector) => document.querySelector(selector);

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, ok: res.ok, data };
}

function setMessage(text, kind = "info") {
  const el = $("#message");
  if (!el) return;
  el.textContent = text || "";
  el.className = `message ${kind}`;
  el.hidden = !text;
}

const page = document.body.dataset.page;

if (page === "signup" || page === "login") {
  const isSignup = page === "signup";
  const form = $("#authForm");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("");
    const email = $("#email").value.trim();
    const password = $("#password").value;
    const button = $("#submit");
    button.disabled = true;
    const { ok, data } = await api(isSignup ? "/api/auth/signup" : "/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    button.disabled = false;
    if (!ok) {
      setMessage(data.error || (isSignup ? "Signup failed." : "Login failed."), "error");
      return;
    }
    if (isSignup && data.email && !data.email.delivered && data.email.mode === "unconfigured") {
      // Account exists and the session is set; go to /verify where the
      // unconfigured-mail notice is shown clearly.
      window.location.assign(data.redirect || "/verify");
      return;
    }
    window.location.assign(data.redirect || (isSignup ? "/verify" : "/"));
  });
}

if (page === "verify") {
  const showExpired = (message) => {
    const verifyCard = $("#verifyCard");
    if (verifyCard) verifyCard.hidden = true;
    $("#expiredCard").hidden = false;
    $("#expiredMessage").textContent =
      message || "Your session expired. Please log in again.";
    setMessage("");
  };

  const onVerify = async (event) => {
    event.preventDefault();
    setMessage("");
    const code = $("#code").value.trim();
    const button = $("#verifySubmit");
    button.disabled = true;
    const { status, ok, data } = await api("/api/auth/verify", {
      method: "POST",
      body: { code },
    });
    button.disabled = false;
    if (status === 401) {
      showExpired(data.error);
      return;
    }
    if (!ok) {
      setMessage(data.error || "Verification failed.", "error");
      return;
    }
    window.location.assign(data.redirect || "/");
  };

  const onResend = async () => {
    setMessage("");
    const { status, ok, data } = await api("/api/auth/resend", {
      method: "POST",
      body: {},
    });
    if (status === 401) {
      showExpired(data.error);
      return;
    }
    if (data.alreadyVerified) {
      window.location.assign("/");
      return;
    }
    if (!ok) {
      setMessage(data.error || "Could not resend the code.", "error");
      return;
    }
    if (data.email && !data.email.delivered) {
      setMessage(
        data.email.mode === "unconfigured"
          ? "Email delivery is not configured yet. Contact the administrator."
          : "We could not send the email right now. Please try again later.",
        "warn",
      );
    } else {
      setMessage("A new verification code has been sent.", "ok");
    }
  };

  (async function init() {
    const session = await api("/api/auth/session");
    if (session.status === 401 || !session.data.authenticated) {
      showExpired(session.data.error);
      return;
    }
    if (session.data.user && session.data.user.verified) {
      window.location.assign("/");
      return;
    }
    $("#emailLabel").textContent = session.data.user?.email || "";
    $("#verifyCard").hidden = false;
    $("#verifyForm").addEventListener("submit", onVerify);
    $("#resend").addEventListener("click", onResend);

    const config = await api("/api/auth/config");
    if (config.data.mode === "unconfigured") {
      setMessage(
        "Email delivery is not configured yet. Contact the administrator.",
        "warn",
      );
    } else if (config.data.mode === "dev") {
      setMessage(
        "Developer email mode is on — check the local dev mailbox for your code.",
        "info",
      );
    }
  })();
}
