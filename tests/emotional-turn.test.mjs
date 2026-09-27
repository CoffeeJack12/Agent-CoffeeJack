/**
 * Casual emotional conversation quality (live audit regressions):
 * - "ياخي انت قهرتني، ما فهمت منك ولا شي" got generic AI-helper boilerplate.
 * - "اليوم نفسيتي تعبانة شوي" addressed the male Owner with feminine grammar
 *   and a canned question.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyEmotionalTurn,
  detectEmotionalReplyViolation,
  emotionalDeterministicReply,
  emotionalTurnPlan,
} from "../server/emotional-turn.mjs";
import { resolveTurnContext } from "../server/conversation-intent.mjs";
import { formatSpeakerPersonaPrompt } from "../server/speaker-persona.mjs";
import { accountBoundSpeaker, QUEEN_USER_ID_SETTING } from "../server/account-personas.mjs";
import { createApp } from "../server/index.mjs";
import { createUser, createSession } from "../server/users.mjs";

const FRUSTRATED = "ياخي انت قهرتني، ما فهمت منك ولا شي";
const LOW_MOOD = "اليوم نفسيتي تعبانة شوي";

const owner = { id: "owner-id", role: "owner", display_name: "Abdulrahman" };
const queenStore = {
  get: (key) => (key === QUEEN_USER_ID_SETTING ? "lubna-id" : ""),
};
const lubna = { id: "lubna-id", role: "standard", display_name: "Lubna" };
const stranger = { id: "std-id", role: "standard", display_name: "Sam" };

const FEMININE_FOR_MALE =
  /إنتِ|انتي|أنتي|تبغين|تبين|تودين|تريدين|تحتاجين|تقدرين|تشعرين|حابة|حابه|عزيزتي|فضفضي|خذي|قولي لي|تفضفضين|تنقهرين/u;
const MASCULINE_FOR_FEMALE =
  /(?<![\u0621-\u064a])(?:حاب|تبغى|تنقهر|فضفض|قول لي|خذ راحتك|خذ نفس|ضعت)(?![\u0621-\u064a])/u;
const BOILERPLATE =
  /ذكاء اصطناعي|نموذج|مساعد|مشاعر|لمساعدتك|كيف (?:يمكنني|أقدر) (?:أن )?أساعدك|أتفهم|يؤسفني|آسف لسماع|هل (?:تريد|تود|ترغب)|مختص|as an ai/iu;

function assertNaturalReply(reply, { user = owner, store = null } = {}) {
  assert.ok(reply, "reply must not be empty");
  assert.ok(reply.length <= 160, `reply too long: ${reply}`);
  assert.doesNotMatch(reply, BOILERPLATE, reply);
  assert.doesNotMatch(reply, /[A-Za-z]/, reply);
  assert.equal(detectEmotionalReplyViolation(reply, { user, store }), null, reply);
}

test("audit prompt 1: frustration + misunderstanding is an emotional fast turn", () => {
  assert.deepEqual(classifyEmotionalTurn(FRUSTRATED), {
    kind: "misunderstood",
    frustrated: true,
  });
  const turn = resolveTurnContext(FRUSTRATED, { history: [], user: owner });
  assert.equal(turn.intent, "emotional");
  assert.equal(turn.taskHint, "emotional_support");
  assert.equal(turn.fastPath, true);
  assert.equal(turn.allowResearch, false);
  assert.equal(turn.allowWebSearch, false);
  assert.equal(turn.allowMemoryWrite, false);
  assert.equal(turn.allowVerification, false);
  assert.equal(turn.emotional.deterministic, true);
});

test("audit prompt 1: reply owns the confusion in Jeddawi, no AI boilerplate", () => {
  const plan = emotionalTurnPlan(FRUSTRATED);
  const reply = emotionalDeterministicReply({ plan, user: owner });
  assertNaturalReply(reply);
  assert.match(reply, /معك حق|حقك علي/u);
  assert.match(reply, /تنقهر(?![\u0621-\u064a])/u, "acknowledges frustration (masculine)");
  assert.match(reply, /أبسط|أختصره/u, "offers a simpler re-explanation");
  assert.doesNotMatch(reply, FEMININE_FOR_MALE);
});

test("audit prompt 2: low mood gets masculine, brief reply without canned question", () => {
  assert.deepEqual(classifyEmotionalTurn(LOW_MOOD), {
    kind: "low_mood",
    frustrated: false,
  });
  const turn = resolveTurnContext(LOW_MOOD, { history: [], user: owner });
  assert.equal(turn.intent, "emotional");
  assert.equal(turn.emotional.deterministic, true);
  const reply = emotionalDeterministicReply({ plan: turn.emotional, user: owner });
  assertNaturalReply(reply);
  assert.match(reply, /^سلامتك يا عبدالرحمن/u);
  assert.match(reply, /حاب|تبغى/u, "masculine verb forms for the Owner");
  assert.doesNotMatch(reply, FEMININE_FOR_MALE);
  assert.doesNotMatch(reply, /هل|[؟?]/u, "no canned question");
});

const VARIANTS = [
  { text: "والله ما فهمت عليك ولا شي", kind: "misunderstood" },
  { text: "كلامك ملخبط، لخبطتني", kind: "misunderstood" },
  { text: "انت نرفزتني اليوم", kind: "upset_with_jack" },
  { text: "زعلان منك", kind: "upset_with_jack" },
  { text: "نفسيتي زفت اليوم", kind: "low_mood" },
  { text: "مالي خلق شي اليوم", kind: "low_mood" },
  { text: "انا متضايقة شوي", kind: "low_mood" },
  { text: "مقهور من الدوام", kind: "venting" },
];

test("nearby variants classify and produce natural gender-correct replies", () => {
  for (const { text, kind } of VARIANTS) {
    const plan = emotionalTurnPlan(text);
    assert.equal(plan?.kind, kind, text);
    assert.equal(resolveTurnContext(text, { history: [], user: owner }).intent, "emotional", text);

    const ownerReply = emotionalDeterministicReply({ plan, user: owner });
    assertNaturalReply(ownerReply);
    assert.doesNotMatch(ownerReply, FEMININE_FOR_MALE, `${text} → ${ownerReply}`);

    const queenReply = emotionalDeterministicReply({ plan, user: lubna, store: queenStore });
    assertNaturalReply(queenReply, { user: lubna, store: queenStore });
    assert.doesNotMatch(queenReply, MASCULINE_FOR_FEMALE, `${text} → ${queenReply}`);

    const neutralReply = emotionalDeterministicReply({ plan, user: stranger });
    assertNaturalReply(neutralReply, { user: stranger });
    assert.equal(detectEmotionalReplyViolation(neutralReply, { user: owner }), null, neutralReply);
    assert.equal(
      detectEmotionalReplyViolation(neutralReply, { user: lubna, store: queenStore }),
      null,
      neutralReply,
    );
  }
});

test("owner writing a feminine form still gets masculine grammar (account wins)", () => {
  const plan = emotionalTurnPlan("انا متضايقة شوي");
  const reply = emotionalDeterministicReply({ plan, user: owner });
  assert.doesNotMatch(reply, FEMININE_FOR_MALE);
  assert.equal(accountBoundSpeaker(owner).gender, "m");
});

test("technical, task, question and about-Jack messages are not emotional turns", () => {
  for (const text of [
    "ما فهمت كيف اشغل البرنامج",
    "السيرفر تعبان",
    "انت تعبان؟",
    "ليش انا دايم تعبان؟",
    "مو زعلان، بس سؤال",
    "نفسيتي زينة اليوم",
    "ابغى افضفض",
    "النتيجة زفت",
    "I'm feeling down today",
  ]) {
    assert.equal(classifyEmotionalTurn(text), null, text);
    assert.notEqual(resolveTurnContext(text, { history: [], user: owner }).intent, "emotional", text);
  }
});

test("repeated emotional turn does not repeat the exact previous line", () => {
  const plan = emotionalTurnPlan(LOW_MOOD);
  const first = emotionalDeterministicReply({ plan, user: owner });
  const second = emotionalDeterministicReply({ plan, user: owner, lastAssistant: first });
  assert.notEqual(first, second);
  assertNaturalReply(second);
});

test("guard rejects the audited failure shapes", () => {
  assert.equal(
    detectEmotionalReplyViolation(
      "أنا آسف لسماع ذلك. كذكاء اصطناعي لا أملك مشاعر، لكن أنا هنا لمساعدتك. كيف يمكنني مساعدتك اليوم؟",
      { user: owner },
    )?.code,
    "boilerplate",
  );
  assert.equal(
    detectEmotionalReplyViolation("سلامتك، هل تودين التحدث عن ما يضايقك؟", { user: owner })?.code,
    "boilerplate",
  );
  assert.equal(
    detectEmotionalReplyViolation("سلامتك، إذا حابة تفضفضين أنا معك.", { user: owner })?.code,
    "wrong_gender",
  );
  assert.equal(
    detectEmotionalReplyViolation("سلامتك، إذا حاب تفضفض أنا معك.", { user: lubna, store: queenStore })?.code,
    "wrong_gender",
  );
  assert.equal(
    detectEmotionalReplyViolation("سلامتك، إذا حاب، نتكلم.", { user: lubna, store: queenStore })?.code,
    "wrong_gender",
    "Arabic comma must act as a word boundary",
  );
  assert.equal(
    detectEmotionalReplyViolation("أنا كمان حزين عشانك.", { user: owner })?.code,
    "sentience",
  );
  assert.equal(
    detectEmotionalReplyViolation("I understand how you feel. How can I help?", { user: owner })?.code,
    "boilerplate",
  );
  assert.equal(
    detectEmotionalReplyViolation("حقك علي، باختصار: الفكرة إن الملف ينحفظ تلقائي.", { user: owner }),
    null,
    "مختصر/باختصار is not a specialist referral",
  );
});

test("lost after a real answer → model re-explains under emotional directive", () => {
  const history = [
    { role: "user", content: "وش الفرق بين الذاكرة المؤقتة والدائمة؟" },
    {
      role: "assistant",
      content:
        "الذاكرة المؤقتة تنمسح أول ما تقفل المحادثة، والدائمة تنحفظ في قاعدة البيانات وترجع لك في المحادثات الجاية.",
    },
  ];
  const turn = resolveTurnContext(FRUSTRATED, { history, user: owner });
  assert.equal(turn.intent, "emotional");
  assert.equal(turn.fastPath, true);
  assert.equal(turn.emotional.deterministic, false);
  assert.match(turn.directive, /re-explain/i);
  assert.match(turn.directive, /MASCULINE/);
  assert.match(turn.directive, /الذاكرة المؤقتة تنمسح/u);
  assert.match(turn.directive, /Do not claim to feel emotions/);
});

test("style: English session skips; MSA session gets MSA register", () => {
  assert.equal(emotionalTurnPlan(LOW_MOOD, { style: { language: "en" } }), null);
  const plan = emotionalTurnPlan(FRUSTRATED, {
    style: { language: "ar", arabic_style: "msa" },
  });
  assert.equal(plan.register, "msa");
  const reply = emotionalDeterministicReply({ plan, user: owner });
  assert.match(reply, /أخبرني/u);
  assertNaturalReply(reply);
});

test("speaker persona prompt pins masculine grammar for the Owner", () => {
  const prompt = formatSpeakerPersonaPrompt(accountBoundSpeaker(owner));
  assert.match(prompt, /masculine grammar/);
  assert.doesNotMatch(prompt, /use feminine grammar/);
  const queenPrompt = formatSpeakerPersonaPrompt(accountBoundSpeaker(lubna, queenStore));
  assert.match(queenPrompt, /feminine grammar for Lubna/);
});

const BOILERPLATE_REPLY =
  "أنا آسف لسماع ذلك. كذكاء اصطناعي لا أملك مشاعر، لكن أنا هنا لمساعدتك. هل تودين التحدث عن ذلك؟";

async function appFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-emotional-"));
  const calls = [];
  const state = { reply: BOILERPLATE_REPLY };
  const fake = {
    models: async () => [{ name: "qwen3:8b" }],
    inspect: async () => ({ capabilities: ["tools"] }),
    prepare: async () => ({ alreadyLoaded: true, unloaded: [] }),
    unload: async () => [],
    chat: async (args) => {
      calls.push(args);
      args.onToken?.(state.reply);
      return { role: "assistant", content: state.reply, tokens: 5 };
    },
  };
  const app = await createApp({ dataDirectory: dir, ollama: fake });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, calls, state };
}

async function chat(base, token, text, chatId) {
  const response = await fetch(base + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CoffeeJack-Token": token },
    body: JSON.stringify({ text, chatId, requestedModel: "auto" }),
  });
  const events = (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  let reply = "";
  for (const e of events) {
    if (e.type === "token") reply += e.text;
    if (e.type === "revise") reply = e.text;
  }
  return {
    events,
    reply: reply.trim(),
    chatId: events.find((e) => e.type === "chat")?.chat?.id || chatId,
    ctx: events.find((e) => e.type === "turn_context"),
  };
}

test("API: both audit prompts answer instantly for the Owner, masculine, no model call", async (t) => {
  const { app, base, calls } = await appFixture(t);

  const low = await chat(base, app.token, LOW_MOOD);
  assert.equal(low.ctx?.intent, "emotional");
  assert.equal(low.ctx?.speakerPersona?.honorific, "Master");
  assertNaturalReply(low.reply);
  assert.doesNotMatch(low.reply, FEMININE_FOR_MALE);
  assert.doesNotMatch(low.reply, /هل|[؟?]/u);

  const frustrated = await chat(base, app.token, FRUSTRATED);
  assert.equal(frustrated.ctx?.intent, "emotional");
  assertNaturalReply(frustrated.reply);
  assert.match(frustrated.reply, /معك حق|حقك علي/u);

  assert.equal(calls.length, 0, "deterministic emotional replies never call the model");
  const stored = app.store.messages(low.chatId).map((m) => m.content);
  assert.ok(stored.includes(LOW_MOOD));
  assert.ok(stored.includes(low.reply));
});

test("API: Queen gets feminine grammar for the same low-mood prompt", async (t) => {
  const { app, base } = await appFixture(t);
  const account = createUser(app.store, { displayName: "Office", role: "standard" });
  app.store.set(QUEEN_USER_ID_SETTING, account.id);
  const session = createSession(app.store, account.id);
  const r = await chat(base, session.token, LOW_MOOD);
  assert.equal(r.ctx?.speakerPersona?.honorific, "Queen");
  assert.match(r.reply, /حابة|تبغي/u);
  assert.doesNotMatch(r.reply, MASCULINE_FOR_FEMALE);
});

test("API: after a real answer, boilerplate model output is replaced; good output kept", async (t) => {
  const { app, base, calls, state } = await appFixture(t);
  const first = await chat(base, app.token, "hey");
  const chatId = first.chatId;
  app.store.message(chatId, "user", "وش الفرق بين الذاكرة المؤقتة والدائمة؟");
  app.store.message(
    chatId,
    "assistant",
    "الذاكرة المؤقتة تنمسح أول ما تقفل المحادثة، والدائمة تنحفظ في قاعدة البيانات وترجع لك في المحادثات الجاية.",
  );

  const bad = await chat(base, app.token, FRUSTRATED, chatId);
  assert.equal(bad.ctx?.intent, "emotional");
  assert.equal(bad.ctx?.emotionalKind, "misunderstood");
  assert.equal(calls.length, 1, "model is asked to re-explain");
  const system = calls[0].messages[0].content;
  assert.match(system, /CASUAL EMOTIONAL TURN/);
  assert.match(system, /MASCULINE/);
  assert.equal(calls[0].tools.length, 0, "no tools on an emotional turn");
  assert.doesNotMatch(bad.reply, BOILERPLATE);
  assertNaturalReply(bad.reply);

  state.reply =
    "حقك علي. باختصار: المؤقتة تروح لما تقفل المحادثة، والدائمة تنحفظ وترجع لك بعدين.";
  const good = await chat(base, app.token, "والله ما فهمت عليك ولا شي", chatId);
  assert.equal(good.reply, state.reply);
});
