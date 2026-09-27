/**
 * English/Arabic UI localization: dictionaries, fallback HTML, live switch,
 * persistence, and a static audit that fails on new hard-coded Arabic copy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARABIC_SCRIPT_RE,
  APP_LANGUAGE_HINT_KEY,
  applyDocumentLocale,
  applyStaticI18n,
  dictionaries,
  dictionaryKeys,
  hasArabicScript,
  persistAppLanguageHint,
  readAppLanguageHint,
  resolveAppLocale,
  t,
} from "../public/i18n.js";
import { createApp } from "../server/index.mjs";
import { createSession, resolveLocalOwner } from "../server/users.mjs";
import { getPreferences, savePreferences } from "../server/preferences.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const ARABIC_SAMPLE_KEYS = new Set([
  "persona.previewQuestion.ar.standard",
  "persona.previewQuestion.ar.jeddah",
  "persona.previewAnswer.ar.standard.playful",
  "persona.previewAnswer.ar.standard.subtle",
  "persona.previewAnswer.ar.standard.off",
  "persona.previewAnswer.ar.jeddah.playful",
  "persona.previewAnswer.ar.jeddah.subtle",
  "persona.previewAnswer.ar.jeddah.off",
  "welcome.suggest.build.prompt",
  "welcome.suggest.search.prompt",
  "welcome.suggest.mood.prompt",
]);
const DELIBERATE_ENGLISH_IN_AR = new Set([
  "brand.tagline",
  "header.workspace",
  "nav.newChatShortcut",
  "persona.previewQuestion.en",
  "persona.previewAnswer.en.playful",
  "persona.previewAnswer.en.subtle",
  "persona.previewAnswer.en.off",
  "auth.brand",
  "lang.en",
  "pack.git",
  "address.master",
  "address.lord",
  "address.sir",
  "tone.jarvis",
  "tone.dark",
  "mode.hacker.label",
  "mode.developer.label",
  "mode.research.label",
  "mode.empathy.label",
  "mode.secret_agent.label",
  "users.role.trusted",
  "users.role.standard",
  "users.role.guest",
  "users.role.owner",
  "account.sourceCoffeeJack",
  "account.sourceCloudflare",
  "councilMaxModels.2",
  "councilMaxModels.3",
  "councilMaxModels.4",
  "selfRepair.none",
]);

const SURFACE_KEYS = {
  settings: [
    "settings.title",
    "settings.intro",
    "settings.localMind",
    "settings.primaryModel",
    "settings.workspaceCard",
    "settings.toolsCard",
    "settings.autoApprove",
    "settings.gamingCard",
    "settings.save",
    "settings.branding",
    "owner.credentials.email",
    "owner.credentials.password",
    "owner.credentials.save",
    "users.title",
    "providers.title",
  ],
  persona: [
    "persona.title.line1",
    "persona.previewTitle",
    "persona.self.title",
    "persona.self.state.ready",
    "persona.awareness.summary",
  ],
  memory: [
    "memory.title",
    "memory.intro",
    "memory.searchPlaceholder",
    "memory.placeholder",
    "memory.save",
    "memory.empty",
    "memory.edit",
  ],
  activity: [
    "activity.title",
    "activity.intro",
    "activity.refresh",
    "activity.empty",
  ],
  lab: [
    "lab.title",
    "lab.targets",
    "lab.field.name",
    "lab.field.host",
    "lab.field.ports",
    "lab.field.protocols",
    "lab.field.environment",
    "lab.field.authNote",
    "lab.addTarget",
    "lab.plans",
    "lab.active",
    "lab.findings",
    "lab.lessons",
    "lab.matrix",
    "lab.empty",
    "lab.new",
    "lab.stop",
    "lab.export",
    "lab.clearLessons",
  ],
  auth: [
    "auth.signIn",
    "auth.createAccount",
    "auth.forgot",
    "auth.reset",
    "auth.verify",
    "auth.email",
    "auth.password",
    "auth.lead.login",
  ],
  nav: [
    "nav.chat",
    "nav.memory",
    "nav.activity",
    "nav.persona",
    "nav.settings",
    "nav.lab",
  ],
};

function i18nKeysFromMarkup(source) {
  const keys = new Set();
  const re = /data-i18n(?:-placeholder|-aria|-title|-prompt)?="([^"]+)"/g;
  let match;
  while ((match = re.exec(source))) keys.add(match[1]);
  return keys;
}

function makeI18nRoot(items) {
  const nodes = items.map((item) => {
    const attrs = { ...item };
    return {
      textContent: item.text || "",
      getAttribute(name) {
        return attrs[name];
      },
      setAttribute(name, value) {
        attrs[name] = value;
      },
    };
  });
  return {
    nodes,
    querySelectorAll(sel) {
      const attr = /\[([^\]]+)\]/.exec(sel)?.[1];
      if (!attr) return [];
      return nodes.filter((node) => node.getAttribute(attr) != null);
    },
  };
}

function generatedUserCard(locale) {
  return [
    t("users.switch", locale),
    t("users.rename", locale),
    t("users.disable", locale),
    t("account.localOnly", locale),
    t("account.linkedCloudflare", locale),
    t("users.remoteSwitchHelp", locale),
  ].join(" · ");
}

function generatedProviderCard(locale) {
  return [
    t("providers.autoTitle", locale),
    t("providers.connected", locale),
    t("providers.notConfigured", locale),
    t("providers.unavailable", locale),
    t("providers.local", locale),
    t("providers.remote", locale),
    t("providers.refresh", locale),
  ].join(" · ");
}

async function startApp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-i18n-"));
  const app = await createApp({
    dataDirectory: dir,
    ollama: {
      models: async () => [{ name: "qwen3:8b" }],
      inspect: async () => ({ capabilities: ["tools"] }),
      unload: async () => [],
    },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  const owner = resolveLocalOwner(app.store);
  const session = createSession(app.store, owner.id, { source: "local" });
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { app, owner, session, base };
}

async function api(base, token, route, { method = "GET", body } = {}) {
  const response = await fetch(base + "/api/" + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

test("en and ar dictionaries have the same keys", () => {
  const en = dictionaryKeys("en").sort();
  const ar = dictionaryKeys("ar").sort();
  assert.deepEqual(ar, en);
  assert.ok(en.length > 200, "expected a complete UI dictionary");
});

test("English dictionary values contain no Arabic script", () => {
  for (const [key, value] of Object.entries(dictionaries.en)) {
    assert.equal(
      hasArabicScript(value),
      false,
      `dictionaries.en[${key}] must stay English`,
    );
  }
});

test("English mode surfaces have no Arabic user-visible labels", () => {
  for (const [surface, keys] of Object.entries(SURFACE_KEYS)) {
    const text = keys.map((key) => t(key, "en")).join("\n");
    assert.equal(
      hasArabicScript(text),
      false,
      `${surface} English copy must not contain Arabic`,
    );
  }
  assert.equal(hasArabicScript(generatedUserCard("en")), false);
  assert.equal(hasArabicScript(generatedProviderCard("en")), false);
});

test("Arabic mode translates navigation, settings, and Security Lab and is RTL", () => {
  assert.deepEqual(resolveAppLocale("ar"), { lang: "ar", dir: "rtl" });
  for (const key of SURFACE_KEYS.nav) {
    assert.equal(hasArabicScript(t(key, "ar")), true, key);
    assert.notEqual(t(key, "ar"), t(key, "en"), key);
  }
  for (const key of [
    "settings.title",
    "settings.save",
    "lab.title",
    "lab.targets",
    "lab.addTarget",
    "lab.empty",
  ]) {
    assert.equal(hasArabicScript(t(key, "ar")), true, key);
    assert.notEqual(t(key, "ar"), t(key, "en"), key);
  }
});

test("switching language updates static UI live without reload", () => {
  const root = makeI18nRoot([
    { "data-i18n": "nav.settings", text: "Settings" },
    { "data-i18n": "settings.title", text: "Jack, your way." },
    { "data-i18n": "lab.title", text: "Security Lab" },
    {
      "data-i18n-placeholder": "memory.searchPlaceholder",
      placeholder: "Search memory…",
    },
    { "data-i18n-aria": "composer.send", "aria-label": "Send" },
    {
      "data-i18n-prompt": "welcome.suggest.build.prompt",
      "data-prompt": dictionaries.en["welcome.suggest.build.prompt"],
    },
  ]);
  applyStaticI18n(root, "ar");
  assert.equal(root.nodes[0].textContent, dictionaries.ar["nav.settings"]);
  assert.equal(root.nodes[1].textContent, dictionaries.ar["settings.title"]);
  assert.equal(root.nodes[2].textContent, dictionaries.ar["lab.title"]);
  assert.equal(
    root.nodes[3].getAttribute("placeholder"),
    dictionaries.ar["memory.searchPlaceholder"],
  );
  assert.equal(
    root.nodes[4].getAttribute("aria-label"),
    dictionaries.ar["composer.send"],
  );
  assert.equal(
    root.nodes[5].getAttribute("data-prompt"),
    dictionaries.ar["welcome.suggest.build.prompt"],
  );
  assert.equal(hasArabicScript(root.nodes[0].textContent), true);

  applyStaticI18n(root, "en");
  assert.equal(root.nodes[0].textContent, dictionaries.en["nav.settings"]);
  assert.equal(root.nodes[1].textContent, dictionaries.en["settings.title"]);
  assert.equal(root.nodes[2].textContent, dictionaries.en["lab.title"]);
  assert.equal(hasArabicScript(root.nodes[1].textContent), false);
  assert.equal(
    root.nodes[5].getAttribute("data-prompt"),
    dictionaries.en["welcome.suggest.build.prompt"],
  );
});

test("document locale follows app language", () => {
  const previous = globalThis.document;
  globalThis.document = { documentElement: { lang: "en", dir: "ltr" } };
  try {
    applyDocumentLocale(resolveAppLocale("ar"));
    assert.equal(document.documentElement.lang, "ar");
    assert.equal(document.documentElement.dir, "rtl");
    applyDocumentLocale(resolveAppLocale("en"));
    assert.equal(document.documentElement.lang, "en");
    assert.equal(document.documentElement.dir, "ltr");
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("saved app language hint persists in localStorage", () => {
  const box = {};
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key) {
      return Object.hasOwn(box, key) ? box[key] : null;
    },
    setItem(key, value) {
      box[key] = String(value);
    },
  };
  try {
    assert.equal(readAppLanguageHint(), "en");
    persistAppLanguageHint("ar");
    assert.equal(box[APP_LANGUAGE_HINT_KEY], "ar");
    assert.equal(readAppLanguageHint(), "ar");
    persistAppLanguageHint("en");
    assert.equal(readAppLanguageHint(), "en");
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test("authenticated appLanguage persists after reload", async (t) => {
  const { app, owner, session, base } = await startApp(t);
  const first = await api(base, session.token, "preferences");
  assert.equal(first.status, 200);
  assert.equal(first.data.preferences.appLanguage, "en");

  const saved = await api(base, session.token, "preferences", {
    method: "POST",
    body: { appLanguage: "ar" },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.appLanguage ?? saved.data.preferences?.appLanguage, "ar");
  assert.equal(getPreferences(app.store, owner.id).appLanguage, "ar");

  const reloaded = createSession(app.store, owner.id, { source: "local" });
  const again = await api(base, reloaded.token, "status");
  assert.equal(again.status, 200);
  assert.equal(again.data.preferences.appLanguage, "ar");

  const other = savePreferences(app.store, { appLanguage: "en" }, "other-user");
  assert.equal(other.appLanguage, "en");
  assert.equal(getPreferences(app.store, owner.id).appLanguage, "ar");
});

test("fallback HTML and auth pages are English with no Arabic remnants", async () => {
  const index = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
  const auth = await fs.readFile(path.join(publicDir, "auth.html"), "utf8");
  assert.match(index, /<html lang="en" dir="ltr">/);
  assert.match(auth, /<html lang="en" dir="ltr">/);
  assert.equal(hasArabicScript(index), false, "index.html fallback must be English");
  assert.equal(hasArabicScript(auth), false, "auth.html fallback must be English");

  for (const [name, html] of [
    ["settings", index.slice(index.indexOf('id="settingsView"'), index.indexOf('id="labView"'))],
    ["persona", index.slice(index.indexOf('id="personaView"'), index.indexOf('id="memoryView"'))],
    ["memory", index.slice(index.indexOf('id="memoryView"'), index.indexOf('id="activityView"'))],
    ["activity", index.slice(index.indexOf('id="activityView"'), index.indexOf('id="settingsView"'))],
    ["lab", index.slice(index.indexOf('id="labView"'), index.indexOf("</main>"))],
  ]) {
    assert.equal(hasArabicScript(html), false, `${name} fallback HTML`);
    assert.match(html, /data-i18n="/);
  }

  for (const html of [index, auth]) {
    for (const key of i18nKeysFromMarkup(html)) {
      assert.ok(dictionaries.en[key], `missing en key ${key}`);
      assert.ok(dictionaries.ar[key], `missing ar key ${key}`);
    }
  }
});

test("static localization audit rejects hard-coded Arabic UI copy", async () => {
  const skip = new Set(["i18n.js"]);
  const files = (await fs.readdir(publicDir)).filter(
    (name) =>
      !name.startsWith(".") &&
      !skip.has(name) &&
      (name.endsWith(".html") || name.endsWith(".js")),
  );
  const offenders = [];
  for (const name of files) {
    const source = await fs.readFile(path.join(publicDir, name), "utf8");
    if (ARABIC_SCRIPT_RE.test(source)) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `hard-coded Arabic UI copy found in ${offenders.join(", ")}`,
  );

  const appJs = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
  assert.doesNotMatch(appJs, /locale === "ar" \?\s*["'`\u0600-\u06FF]/);
  assert.doesNotMatch(appJs, /confirm\(\s*"/);
  assert.doesNotMatch(appJs, /prompt\(\s*"/);
  assert.match(appJs, /tr\("memory.edit"\)/);
  assert.match(appJs, /tr\("owner.credentials.saved"\)/);
  assert.match(appJs, /tr\("lab.empty"\)/);
  assert.match(appJs, /tr\("lab.plan.pipeline"\)/);
  assert.match(appJs, /tr\("council.title"\)/);
  assert.match(appJs, /tr\("research.sources"/);
  assert.match(appJs, /await applyAppLanguage/);
  assert.match(appJs, /jobs.push\(loadPreferences\(\)/);
});

test("Arabic dictionary keeps natural UI copy except deliberate tokens", () => {
  for (const [key, value] of Object.entries(dictionaries.ar)) {
    if (DELIBERATE_ENGLISH_IN_AR.has(key)) continue;
    if (/^[A-Z0-9._-]+$/.test(value)) continue;
    if (value === "—") continue;
    if (!hasArabicScript(value)) {
      assert.ok(
        /Ollama|CoffeeJack|Jack|Auto|Ctrl|RFC|SHA|Ghidra|YARA|127\.0\.0\.1/.test(
          value,
        ) || key.startsWith("persona.previewAnswer.en"),
        `Arabic UI key ${key} unexpectedly English: ${value}`,
      );
    }
  }
  for (const key of ARABIC_SAMPLE_KEYS) {
    assert.equal(hasArabicScript(dictionaries.ar[key]), true, key);
  }
});

test("t() never returns Arabic when locale is English", () => {
  for (const key of dictionaryKeys("en")) {
    assert.equal(hasArabicScript(t(key, "en")), false, key);
  }
});
