/**
 * Privileged honorifics are account-bound. Chat claims cannot grant Queen.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applySpeakerPersonaClaim,
  detectSpeakerPersonaClaim,
  LUBNA_SPEAKER,
  OWNER_SPEAKER,
} from "../server/speaker-persona.mjs";
import { personaDeterministicReply } from "../server/conversation-style.mjs";
import { classifyPersonaIntent } from "../server/turn-priority.mjs";
import { resolveTurnContext } from "../server/conversation-intent.mjs";
import { createApp } from "../server/index.mjs";
import { createUser, createSession, resolveLocalOwner } from "../server/users.mjs";
import { QUEEN_USER_ID_SETTING } from "../server/account-personas.mjs";

const JEDDAWI = {
  language: "ar",
  arabic_style: "jeddawi",
  tone: "casual",
  verbosity: "normal",
};

const owner = { role: "owner", display_name: "Abdulrahman" };

test("انا لبنى is classified but does not grant Queen", () => {
  assert.equal(classifyPersonaIntent("انا لبنى"), "identify_lubna");
  assert.equal(classifyPersonaIntent("I'm Lubna"), "identify_lubna");
  assert.equal(classifyPersonaIntent("اسمي لبنى"), "identify_lubna");
  assert.equal(classifyPersonaIntent("لبنى معاك"), "identify_lubna");
  const p = applySpeakerPersonaClaim(OWNER_SPEAKER, "انا لبنى", owner);
  assert.equal(p.speaker_name, "Abdulrahman");
  assert.equal(p.honorific, "Master");
  assert.deepEqual(detectSpeakerPersonaClaim("أنا لبنى").kind, "identify_lubna");
});

test("stored Lubna speaker does not grant Queen to Owner follow-up", () => {
  const turn = resolveTurnContext("ايش اسوي دحين؟", {
    user: owner,
    previousStyle: JEDDAWI,
    previousSpeakerPersona: LUBNA_SPEAKER,
  });
  assert.equal(turn.speakerPersona.honorific, "Master");
  assert.match(turn.stylePrompt, /honorific=Master/);
});

test("What should you call me? uses authenticated Owner as Master", () => {
  assert.equal(classifyPersonaIntent("What should you call me?"), "call_me");
  assert.equal(
    personaDeterministicReply({ language: "en" }, owner, "call_me", LUBNA_SPEAKER),
    "Master.",
  );
  assert.equal(
    personaDeterministicReply(JEDDAWI, owner, "who_am_i", LUBNA_SPEAKER),
    "إنت يا عبدالرحمن، Master.",
  );
});

test("I'm Abdulrahman on Owner stays Master", () => {
  assert.equal(classifyPersonaIntent("I'm Abdulrahman"), "identify_abdulrahman");
  const p = applySpeakerPersonaClaim(LUBNA_SPEAKER, "انا عبدالرحمن", owner);
  assert.equal(p.speaker_name, "Abdulrahman");
  assert.equal(p.honorific, "Master");
  assert.equal(
    personaDeterministicReply({ language: "en" }, owner, "identify_abdulrahman", p),
    "Got it, Master.",
  );
});

test("Owner I'm Lubna canned reply stays Master", () => {
  assert.equal(
    personaDeterministicReply(JEDDAWI, owner, "identify_lubna", LUBNA_SPEAKER),
    "عرفتك يا Master.",
  );
});

test("existing Owner/Master who_master remains", () => {
  assert.equal(classifyPersonaIntent("مين سيدك؟"), "who_master");
  assert.equal(
    personaDeterministicReply(JEDDAWI, owner, "who_master"),
    "إنت يا عبدالرحمن، Master.",
  );
});

test("display name Lubna without bound user id is not Queen", () => {
  const impostor = { id: "user-impostor", role: "standard", display_name: "Lubna" };
  const p = applySpeakerPersonaClaim(null, "I'm Lubna", impostor);
  assert.equal(p.honorific, null);
  assert.notEqual(p.honorific, "Queen");
  assert.equal(
    personaDeterministicReply({ language: "en" }, impostor, "call_me", LUBNA_SPEAKER),
    "Lubna",
  );
});

test("bound Queen user id receives Queen even with another display name", () => {
  const store = {
    get(key) {
      return key === QUEEN_USER_ID_SETTING ? "lubna-account-id" : "";
    },
  };
  const lubna = {
    id: "lubna-account-id",
    role: "standard",
    display_name: "Someone Else",
  };
  const p = applySpeakerPersonaClaim(null, "hello", lubna, store);
  assert.equal(p.speaker_name, "Lubna");
  assert.equal(p.honorific, "Queen");
  assert.equal(
    personaDeterministicReply({ language: "en" }, lubna, "call_me", null, "", store),
    "Queen.",
  );
});

async function appFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-speaker-"));
  const fake = {
    models: async () => [{ name: "qwen3:8b" }],
    inspect: async () => ({ capabilities: ["tools"] }),
    prepare: async () => ({ alreadyLoaded: true, unloaded: [] }),
    unload: async () => [],
    chat: async (args) => {
      const text = "Acknowledged.";
      args.onToken?.(text);
      return { role: "assistant", content: text, tokens: 2 };
    },
  };
  const app = await createApp({ dataDirectory: dir, ollama: fake });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, dir };
}

async function chat(base, token, text, chatId) {
  const response = await fetch(base + "/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": token,
    },
    body: JSON.stringify({ text, chatId, requestedModel: "auto" }),
  });
  const events = (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const reply = events
    .filter((e) => e.type === "token")
    .map((e) => e.text)
    .join("");
  return {
    events,
    reply,
    chatId: events.find((e) => e.type === "chat")?.chat?.id || chatId,
    ctx: events.find((e) => e.type === "turn_context"),
    priority: events.find((e) => e.type === "priority"),
  };
}

test("API: Owner I'm Lubna does not become Queen", async (t) => {
  const { app, base } = await appFixture(t);
  const before = resolveLocalOwner(app.store);
  assert.equal(before.role, "owner");
  const a = await chat(base, app.token, "انا لبنى");
  assert.equal(a.priority?.personaKind, "identify_lubna");
  assert.equal(a.ctx?.speakerPersona?.honorific, "Master");
  assert.equal(a.reply, "عرفتك يا Master.");
  const after = resolveLocalOwner(app.store);
  assert.equal(after.role, "owner");
  assert.equal(after.id, before.id);

  const b = await chat(base, app.token, "What should you call me?", a.chatId);
  assert.equal(b.reply.replace(/\s+/g, " ").trim(), "Master.");

  const c = await chat(base, app.token, "I'm Abdulrahman", a.chatId);
  assert.equal(c.ctx?.speakerPersona?.honorific, "Master");
  assert.equal(resolveLocalOwner(app.store).role, "owner");
});

test("API: Standard user I'm Lubna stays Standard and is not Queen", async (t) => {
  const { app, base } = await appFixture(t);
  const standard = createUser(app.store, {
    displayName: "StandardUser",
    role: "standard",
  });
  const session = createSession(app.store, standard.id);
  const r = await chat(base, session.token, "I'm Lubna");
  assert.notEqual(r.ctx?.speakerPersona?.honorific, "Queen");
  assert.notEqual(r.ctx?.speakerPersona?.speaker_name, "Lubna");
  const row = app.store.db
    .prepare("SELECT role FROM users WHERE id = ?")
    .get(standard.id);
  assert.equal(row.role, "standard");
});

test("API: Standard user I'm Abdulrahman does not become Owner", async (t) => {
  const { app, base } = await appFixture(t);
  const standard = createUser(app.store, {
    displayName: "StandardUser",
    role: "standard",
  });
  const session = createSession(app.store, standard.id);
  const r = await chat(base, session.token, "I'm Abdulrahman");
  assert.equal(r.priority?.personaKind, "identify_abdulrahman");
  const row = app.store.db
    .prepare("SELECT role FROM users WHERE id = ?")
    .get(standard.id);
  assert.equal(row.role, "standard");
  const owners = app.store.db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'")
    .get();
  assert.equal(owners.n, 1);
  assert.notEqual(standard.id, resolveLocalOwner(app.store).id);
});

test("API: bound Lubna user id receives Queen; impostor display name does not", async (t) => {
  const { app, base } = await appFixture(t);
  const lubna = createUser(app.store, {
    displayName: "Office Account",
    role: "standard",
  });
  app.store.set(QUEEN_USER_ID_SETTING, lubna.id);
  const impostor = createUser(app.store, {
    displayName: "Lubna",
    role: "standard",
  });
  const queenSession = createSession(app.store, lubna.id);
  const impostorSession = createSession(app.store, impostor.id);

  const queenHey = await chat(base, queenSession.token, "hey");
  assert.equal(queenHey.reply, "At your service, Queen.");
  assert.equal(queenHey.ctx?.speakerPersona?.honorific, "Queen");

  const impostorHey = await chat(base, impostorSession.token, "I'm Lubna");
  assert.notEqual(impostorHey.reply, "At your service, Queen.");
  assert.notEqual(impostorHey.ctx?.speakerPersona?.honorific, "Queen");
  assert.doesNotMatch(impostorHey.reply, /Queen/);
});
