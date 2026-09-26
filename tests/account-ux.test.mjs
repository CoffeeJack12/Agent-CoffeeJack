/**
 * English default UI, account-bound Queen, instant greetings without Ollama.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/index.mjs";
import {
  DEFAULT_PREFERENCES,
  getPreferences,
  savePreferences,
} from "../server/preferences.mjs";
import { resolveAppLocale } from "../public/i18n.js";
import {
  QUEEN_USER_ID_SETTING,
  boundQueenUserId,
  isQueenAccount,
} from "../server/account-personas.mjs";
import {
  greetingDeterministicReply,
  isPureGreeting,
} from "../server/greeting.mjs";
import { applySpeakerPersonaClaim } from "../server/speaker-persona.mjs";
import { createUser, createSession, resolveLocalOwner } from "../server/users.mjs";

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-account-ux-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

test("English is the default app language for new and auto profiles", async (t) => {
  assert.equal(DEFAULT_PREFERENCES.appLanguage, "en");
  assert.deepEqual(resolveAppLocale("auto"), { lang: "en", dir: "ltr" });
  assert.deepEqual(resolveAppLocale(undefined), { lang: "en", dir: "ltr" });
  assert.deepEqual(resolveAppLocale("en"), { lang: "en", dir: "ltr" });
  assert.deepEqual(resolveAppLocale("ar"), { lang: "ar", dir: "rtl" });

  const dir = await tempDir(t);
  const store = new Store(dir);
  t.after(() => store.close());
  assert.equal(getPreferences(store).appLanguage, "en");
  store.saveProfilePreferences(resolveLocalOwner(store).id, {
    ...DEFAULT_PREFERENCES,
    appLanguage: "auto",
  });
  const coerced = getPreferences(store);
  assert.equal(coerced.appLanguage, "en");
  const raw = store.profilePreferences(resolveLocalOwner(store).id);
  assert.equal(raw.appLanguage, "auto");
});

test("explicit Arabic app language persists without rewriting other users", async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir);
  t.after(() => store.close());
  const saved = savePreferences(store, { appLanguage: "ar" });
  assert.equal(saved.appLanguage, "ar");
  assert.equal(getPreferences(store).appLanguage, "ar");
  const other = savePreferences(store, { appLanguage: "en" }, "other-user");
  assert.equal(other.appLanguage, "en");
  assert.equal(getPreferences(store).appLanguage, "ar");
  assert.equal(getPreferences(store, "other-user").appLanguage, "en");
});

test("Queen binds only to the configured user id", () => {
  const store = {
    get(key) {
      return key === QUEEN_USER_ID_SETTING ? "lubna-uuid-1" : "";
    },
  };
  if (!process.env.COFFEEJACK_QUEEN_USER_ID)
    assert.equal(boundQueenUserId(store), "lubna-uuid-1");
  assert.equal(
    isQueenAccount({ id: "lubna-uuid-1", display_name: "X" }, store),
    true,
  );
  assert.equal(
    isQueenAccount({ id: "other", display_name: "Lubna" }, store),
    false,
  );
  assert.equal(isQueenAccount({ display_name: "Lubna" }, store), false);
  assert.equal(
    applySpeakerPersonaClaim(
      null,
      "I'm Lubna",
      {
        id: "other",
        role: "standard",
        display_name: "Lubna",
      },
      store,
    ).honorific,
    null,
  );
});

test("pure greetings are recognized", () => {
  for (const text of ["hey", "hi", "hello", "hey jack", "السلام عليكم", "هلا", "هاي", "Hey!", "hello."]) {
    assert.equal(isPureGreeting(text), true, text);
  }
  assert.equal(isPureGreeting("hey jack how are you"), false);
  assert.equal(isPureGreeting("what are your limits?"), false);
});

test("deterministic greetings use account honorifics only", () => {
  assert.equal(
    greetingDeterministicReply({
      user: { role: "owner", display_name: "Abdulrahman" },
      text: "hey",
    }),
    "At your service, Master.",
  );
  assert.equal(
    greetingDeterministicReply({
      user: { id: "lubna-id", role: "standard", display_name: "Office" },
      text: "هلا",
      store: { get: (key) => (key === QUEEN_USER_ID_SETTING ? "lubna-id" : "") },
    }),
    "At your service, Queen.",
  );
  assert.equal(
    greetingDeterministicReply({
      user: { id: "sam", role: "standard", display_name: "Lubna" },
      text: "hey",
    }),
    "Hey.",
  );
  assert.equal(
    greetingDeterministicReply({
      user: { id: "sam", role: "standard", display_name: "Sam" },
      text: "السلام عليكم",
    }),
    "وعليكم السلام.",
  );
  assert.doesNotMatch(
    greetingDeterministicReply({
      user: { id: "sam", role: "standard", display_name: "Lubna" },
      text: "hello",
    }),
    /Queen|Master/,
  );
});

async function chat(base, token, text) {
  const response = await fetch(base + "/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": token,
    },
    body: JSON.stringify({ text, requestedModel: "auto" }),
  });
  const events = (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    status: response.status,
    events,
    reply: events.filter((e) => e.type === "token").map((e) => e.text).join(""),
    ctx: events.find((e) => e.type === "turn_context"),
  };
}

test("API: Owner/Queen/normal greetings never touch Ollama", async (t) => {
  const dir = await tempDir(t);
  const counts = { chat: 0, prepare: 0, models: 0, inspect: 0 };
  const fake = {
    models: async () => {
      counts.models++;
      return [{ name: "qwen3:8b" }];
    },
    inspect: async () => {
      counts.inspect++;
      return { capabilities: ["tools"] };
    },
    prepare: async () => {
      counts.prepare++;
      return { alreadyLoaded: true, unloaded: [] };
    },
    unload: async () => [],
    chat: async () => {
      counts.chat++;
      throw new Error("Ollama invoked on a pure greeting");
    },
  };
  const app = await createApp({ dataDirectory: dir, ollama: fake });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const ownerHey = await chat(base, app.token, "hey jack");
  assert.equal(ownerHey.reply, "At your service, Master.");
  assert.equal(ownerHey.ctx?.instantGreeting, true);

  const lubna = createUser(app.store, { displayName: "Office", role: "standard" });
  app.store.set(QUEEN_USER_ID_SETTING, lubna.id);
  const queenSession = createSession(app.store, lubna.id);
  const queenHi = await chat(base, queenSession.token, "hi");
  assert.equal(queenHi.reply, "At your service, Queen.");

  const normal = createUser(app.store, { displayName: "Sam", role: "standard" });
  const normalSession = createSession(app.store, normal.id);
  const normalHello = await chat(base, normalSession.token, "hello");
  assert.equal(normalHello.reply, "Hello.");
  assert.doesNotMatch(normalHello.reply, /Queen|Master/);

  const salaam = await chat(base, normalSession.token, "السلام عليكم");
  assert.equal(salaam.reply, "وعليكم السلام.");
  const hala = await chat(base, normalSession.token, "هلا");
  assert.equal(hala.reply, "هلا.");
  const hay = await chat(base, normalSession.token, "هاي");
  assert.equal(hay.reply, "هاي.");

  assert.deepEqual(counts, { chat: 0, prepare: 0, models: 0, inspect: 0 });
  for (const result of [ownerHey, queenHi, normalHello, salaam, hala, hay]) {
    assert.equal(result.events.some((e) => e.type === "routing"), false);
    assert.equal(result.events.some((e) => e.type === "council"), false);
    assert.equal(result.events.some((e) => e.type === "tool"), false);
    assert.equal(result.events.some((e) => e.type === "memory"), false);
  }
});
