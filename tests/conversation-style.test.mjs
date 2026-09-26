/**
 * Conversation language/dialect/style state regressions.
 * Every user-visible path must respect taskState.style.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { resolveTurnContext } from "../server/conversation-intent.mjs";
import {
  applyStylePatch,
  classifyArabicFollowUp,
  classifyStyleCommand,
  detectStyleViolation,
  formatConversationStylePrompt,
  formatFinalOutputContract,
  normalizeConversationStyle,
  personaDeterministicReply,
  buildStyleRevisionPrompt,
  isJeddawiActive,
} from "../server/conversation-style.mjs";
import { classifyPersonaIntent } from "../server/turn-priority.mjs";

const JEDDAWI = Object.freeze({
  language: "ar",
  arabic_style: "jeddawi",
  tone: "casual",
  verbosity: "normal",
});

const FORBIDDEN_EGYPTIAN = /مفيش|عايز|عاوز|\bمش\b|إزاي|ازاي/;
const FAKE_TRANSLIT = /\b(?:Duhin|Duheen|Asr)\b/i;

test("style: Jeddawi / MSA / English classification", () => {
  assert.equal(
    classifyStyleCommand(
      "من دحين كلمني جداوي طبيعي، زي واحد من جدة يعرفني. لا فصحى ولا مصري ولا خليجي عام.",
    )?.kind,
    "jeddawi",
  );
  assert.equal(classifyStyleCommand("ارجع جداوي")?.kind, "jeddawi");
  assert.equal(
    classifyStyleCommand("ارجع جداوي وكمل نفس الموضوع")?.kind,
    "jeddawi",
  );
  assert.equal(classifyStyleCommand("فصحى")?.kind, "msa");
  assert.equal(classifyStyleCommand("English now")?.kind, "english");
  const prompt = formatConversationStylePrompt(JEDDAWI);
  assert.match(prompt, /FINAL user-visible|JEDDAWI/i);
  assert.doesNotMatch(prompt, /SEMANTIC DRAFT/i);
  assert.match(prompt, /No emojis/i);
  const contract = formatFinalOutputContract(JEDDAWI);
  assert.match(contract, /JEDDAWI STYLE PRINCIPLES|Naturalness/i);
  assert.match(contract, /paths|URLs|commands|code/i);
});

test("style: language switch applies on the same response turn", () => {
  const hist = [
    { role: "user", content: "نادي دحين ولا بعد العشا؟" },
    { role: "assistant", content: "روح دحين إذا خفيف عليك." },
  ];
  const afterEn = resolveTurnContext("English now", {
    history: hist,
    previousStyle: JEDDAWI,
  });
  assert.equal(afterEn.conversationStyle.language, "en");
  assert.match(afterEn.stylePrompt, /FINAL OUTPUT CONTRACT/i);
  assert.match(afterEn.stylePrompt, /English/i);

  // Critical: same-turn switch back — style must be ar/jeddawi BEFORE reply gen.
  const back = resolveTurnContext("ارجع جداوي وكمل نفس الموضوع", {
    history: [
      ...hist,
      { role: "user", content: "English now" },
      { role: "assistant", content: "Go now if you feel light." },
    ],
    previousStyle: afterEn.conversationStyle,
  });
  assert.equal(back.intent, "style_switch");
  assert.equal(back.conversationStyle.language, "ar");
  assert.equal(back.conversationStyle.arabic_style, "jeddawi");
  assert.equal(isJeddawiActive(back.conversationStyle), true);
  assert.match(back.directive, /Jeddawi Arabic script THIS TURN/i);
  assert.match(back.stylePrompt, /JEDDAWI STYLE PRINCIPLES|FINAL user-visible|JEDDAWI/i);
  assert.match(back.directive, /ACTIVE TOPIC|Stay on this topic/i);
});

test("style: Arabic follow-ups bind to topic intents", () => {
  assert.equal(classifyArabicFollowUp("دحين ايش اسوي؟")?.hint, "what_now");
  assert.equal(classifyArabicFollowUp("طيب لو ما زبط؟")?.hint, "fallback_if_fails");
  assert.equal(classifyArabicFollowUp("طيب اختصرها")?.intent, "rewrite");
  const hist = [
    {
      role: "user",
      content: "ايش رايك اروح النادي دحين ولا بعد العشا؟",
    },
    {
      role: "assistant",
      content: "إذا دوبك متعشي استنى شوي، إذا خفيف عليك روح دحين.",
    },
  ];
  const now = resolveTurnContext("دحين ايش اسوي؟", {
    history: hist,
    previousStyle: JEDDAWI,
  });
  assert.equal(now.intent, "continue");
  assert.equal(now.conversationStyle.arabic_style, "jeddawi");
  assert.match(now.directive, /ACTIVE TOPIC|active topic/i);
  assert.match(now.stylePrompt, /JEDDAWI|FINAL OUTPUT/i);

  const fail = resolveTurnContext("طيب لو ما زبط؟", {
    history: hist,
    previousStyle: JEDDAWI,
  });
  assert.equal(fail.intent, "clarify");
  assert.match(fail.effectiveIntent, /ما زبط|fails|fallback/i);
  assert.equal(fail.conversationStyle.language, "ar");
});

test("style: rewrite + concise follow-ups keep Jeddawi", () => {
  const hist = [
    { role: "user", content: "نادي دحين؟" },
    { role: "assistant", content: "إذا خفيف عليك روح دحين." },
  ];
  const short = resolveTurnContext("طيب اختصرها", {
    history: hist,
    previousStyle: JEDDAWI,
  });
  assert.equal(short.intent, "rewrite");
  assert.equal(short.conversationStyle.arabic_style, "jeddawi");
  assert.match(short.stylePrompt, /JEDDAWI|FINAL/i);

  const butter = resolveTurnContext("يا حبيبي لا تفلسفها، اديني الزبدة", {
    history: hist,
    previousStyle: JEDDAWI,
  });
  assert.equal(butter.conversationStyle.tone, "concise");
  assert.equal(butter.conversationStyle.arabic_style, "jeddawi");
  assert.equal(butter.conversationStyle.language, "ar");
});

test("persona: deterministic replies respect active language", () => {
  const owner = { role: "owner", display_name: "Abdulrahman" };
  assert.equal(
    personaDeterministicReply(JEDDAWI, owner, "who_master"),
    "إنت يا عبدالرحمن، Master.",
  );
  assert.equal(
    personaDeterministicReply({ language: "en" }, owner, "who_master"),
    "Abdulrahman is my Owner and Master.",
  );
  assert.match(
    personaDeterministicReply(
      { language: "ar", arabic_style: "msa" },
      owner,
      "who_master",
    ),
    /عبدالرحمن|سيدي/,
  );
  assert.doesNotMatch(
    personaDeterministicReply(JEDDAWI, owner, "who_master"),
    /Abdulrahman is my Owner/,
  );
});

test("persona: مين سيدك؟ + Jeddawi style uses Owner identity in Arabic", () => {
  assert.equal(classifyPersonaIntent("مين سيدك؟"), "who_master");
  const owner = { role: "owner", display_name: "Abdulrahman" };
  const turn = resolveTurnContext("مين سيدك؟", {
    user: owner,
    previousStyle: JEDDAWI,
  });
  assert.equal(turn.priorityLane, "persona");
  assert.match(turn.directive, /إنت يا|عبدالرحمن|Jeddawi|Master/i);
  assert.equal(turn.conversationStyle.arabic_style, "jeddawi");
  assert.equal(turn.resetTaskState, false);
});

test("dialect guard: detects English / Egyptian / transliteration / stuffing once", () => {
  assert.equal(
    detectStyleViolation(
      "Just go with the flow and hit the gym later.",
      JEDDAWI,
    )?.code,
    "english_while_arabic",
  );
  assert.equal(
    detectStyleViolation("مفيش حاجة دحين.", JEDDAWI)?.code,
    "egyptian",
  );
  assert.equal(
    detectStyleViolation("Go after Duhin Asr.", JEDDAWI)?.code,
    "transliteration",
  );
  assert.equal(
    detectStyleViolation("أهلاً، خلاص شو رأيك؟", JEDDAWI)?.code,
    "levantine",
  );
  assert.equal(
    detectStyleViolation("مالك تعبّد ليش؟ خلّك جدة نايم", JEDDAWI)?.code,
    "malformed",
  );
  assert.equal(
    detectStyleViolation(
      "السياق السابق محفوظ. أحتاج التفصيل الناقص فقط حتى أتابع.",
      JEDDAWI,
    )?.code,
    "stiff_msa",
  );
  assert.equal(
    detectStyleViolation(
      "ارجع، أنا حاسس أني بتحكي معاك زي واحد من جدة، طبيعي وبحب التواصـل.",
      JEDDAWI,
      { userText: "ارجع جداوي وكمل نفس الموضوع" },
    )?.code,
    "meta_style",
  );
  assert.equal(
    detectStyleViolation("دحين، خلّك، يلا، دوبك، ما زبط", JEDDAWI)?.code,
    "keyword_stuffed",
  );
  assert.equal(
    detectStyleViolation("روح النادي دحين إذا خفيف عليك.", JEDDAWI),
    null,
  );
  void FAKE_TRANSLIT;
  const rev = buildStyleRevisionPrompt(JEDDAWI, {
    code: "keyword_stuffed",
    detail: "stuff",
  });
  assert.match(rev, /one attempt only/i);
  assert.match(rev, /Jeddawi|Arabic|STYLE PRINCIPLES|STYLE PACK/i);
});

test("normalize + applyStylePatch forces ar on jeddawi", () => {
  const s = applyStylePatch(
    normalizeConversationStyle({ language: "en" }),
    { arabic_style: "jeddawi" },
  );
  assert.equal(s.arabic_style, "jeddawi");
  assert.equal(s.language, "ar");
});

test("API: Jeddawi direct path; renderer only on guard fail; persona/English skip", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-style-"));
  const prompts = [];
  let renderCalls = 0;
  let jeddawiCoreCalls = 0;
  const fake = {
    models: async () => [{ name: "qwen3:8b" }, { name: "qwen3:14b" }],
    inspect: async () => ({ capabilities: ["tools"] }),
    prepare: async () => ({ alreadyLoaded: true, unloaded: [] }),
    unload: async () => [],
    chat: async (args) => {
      prompts.push(args.messages);
      const allSys = (args.messages || [])
        .filter((m) => m.role === "system")
        .map((m) => m.content || "")
        .join("\n");
      const sys = allSys;
      const user = [...(args.messages || [])]
        .reverse()
        .find((m) => m.role === "user")?.content;

      // Jeddawi Renderer stage (fallback only)
      if (/Jeddawi Renderer/i.test(sys)) {
        renderCalls++;
        const draft = (user || "").split(/SEMANTIC DRAFT:\n|DRAFT:\n/i)[1] || "";
        const text = draft
          ? `خلّك: ${draft.replace(/⟦CJ\d+⟧/g, (m) => m)}`
          : "روح النادي إذا تقدر.";
        args.onToken?.(text);
        return { role: "assistant", content: text, tokens: 2 };
      }

      let text = "طيب.";
      if (/PERSONA \/ IDENTITY TURN/i.test(sys))
        text = "إنت يا عبدالرحمن، Master.";
      else if (
        /FINAL OUTPUT LANGUAGE:\s*English/i.test(sys) ||
        (/language=en/i.test(sys) && !/arabic_style=jeddawi/i.test(sys))
      )
        text = "Go now if you feel light; otherwise wait after dinner.";
      else if (
        /arabic_style=jeddawi|JEDDAWI|FINAL user-visible/i.test(sys) &&
        /نادي|عشا|ACTIVE TOPIC/i.test(user || sys)
      ) {
        jeddawiCoreCalls++;
        // Clean direct Jeddawi — guard should PASS (no renderer).
        text = "إذا مو جوعان روح دحين وافتك. إذا بتتعشى قريب، خله بعدها.";
      } else if (/arabic_style=jeddawi|JEDDAWI|FINAL user-visible/i.test(sys)) {
        jeddawiCoreCalls++;
        text = "تمام، نكمل على نفس الموضوع.";
      } else if (/arabic_style=msa|ARABIC STYLE = MSA/i.test(sys))
        text = "يمكنك الذهاب الآن إن كان ذلك مناسباً، أو بعد العشاء.";
      args.onToken?.(text);
      return { role: "assistant", content: text, tokens: 3 };
    },
  };
  const app = await createApp({ dataDirectory: dir, ollama: fake });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  async function chat(text, chatId) {
    const res = await fetch(base + "/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CoffeeJack-Token": app.token,
      },
      body: JSON.stringify({ text, chatId }),
    });
    const events = (await res.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    let reply = "";
    for (const e of events) {
      if (e.type === "token") reply += e.text || "";
      if (e.type === "revise") reply = e.text == null ? reply : e.text;
    }
    return {
      chatId: events.find((e) => e.type === "chat")?.chat?.id || chatId,
      ctx: events.find((e) => e.type === "turn_context"),
      render: events.find((e) => e.type === "jeddawi_render"),
      guard: events.find((e) => e.type === "jeddawi_guard"),
      done: events.find((e) => e.type === "done"),
      reply,
    };
  }

  let chatId;
  const t1 = await chat(
    "من دحين كلمني جداوي طبيعي، زي واحد من جدة يعرفني.",
  );
  chatId = t1.chatId;
  assert.equal(t1.ctx?.conversationStyle?.arabic_style, "jeddawi");
  assert.equal(t1.render, undefined, "clean direct path must not invoke renderer");
  assert.equal(t1.done?.renderer_used, false);
  assert.equal(t1.done?.jeddawi_direct_pass, true);
  assert.match(t1.reply, /[\u0600-\u06ff]/);

  const t2 = await chat("ايش رايك اروح النادي دحين ولا بعد العشا؟", chatId);
  assert.equal(t2.render, undefined);
  assert.equal(t2.done?.renderer_used, false);
  assert.doesNotMatch(t2.reply, FORBIDDEN_EGYPTIAN);
  assert.match(t2.reply, /نادي|عشا|دحين|روح/);

  const t3 = await chat("English now", chatId);
  assert.equal(t3.ctx?.conversationStyle?.language, "en");
  assert.equal(t3.render, undefined);
  assert.match(t3.reply, /[A-Za-z]/);

  const t4 = await chat("ارجع جداوي وكمل نفس الموضوع", chatId);
  assert.equal(t4.ctx?.conversationStyle?.language, "ar");
  assert.equal(t4.render, undefined, "same-turn Jeddawi uses direct path when clean");
  assert.match(t4.reply, /[\u0600-\u06ff]/);

  const t5 = await chat("مين سيدك؟", chatId);
  assert.equal(t5.ctx?.intent, "persona");
  assert.match(t5.reply, /إنت يا عبدالرحمن/);
  assert.equal(t5.render, undefined, "persona must not invoke renderer");
  assert.equal(renderCalls, 0, "renderer must not run when direct guard passes");
  assert.ok(jeddawiCoreCalls >= 1);

  const directSys = prompts
    .map((ms) => ms.find((m) => m.role === "system")?.content || "")
    .find((c) => /FINAL user-visible|JEDDAWI STYLE PRINCIPLES|JEDDAWI STYLE PACK/i.test(c));
  assert.ok(directSys, "core prompts must request direct FINAL Jeddawi");
  assert.doesNotMatch(directSys, /SEMANTIC DRAFT MODE/);
});

test("API: renderer runs once when direct guard fails; no loop", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-guard-fail-"));
  let renderCalls = 0;
  let coreCalls = 0;
  const fake = {
    models: async () => [{ name: "qwen3:14b" }, { name: "qwen3:8b" }],
    inspect: async () => ({ capabilities: ["tools"] }),
    prepare: async () => ({ alreadyLoaded: true, unloaded: [] }),
    unload: async () => [],
    chat: async (args) => {
      const sys = (args.messages || [])
        .filter((m) => m.role === "system")
        .map((m) => m.content || "")
        .join("\n");
      if (/Jeddawi Renderer/i.test(sys)) {
        renderCalls++;
        const text = "إذا مو جوعان روح دحين وافتك.";
        args.onToken?.(text);
        return { role: "assistant", content: text, tokens: 2 };
      }
      coreCalls += 1;
      // First turn: clean direct (guard passes). Later: contaminated → one fallback.
      const text =
        coreCalls === 1
          ? "تمام، بنتكلم جداوي طبيعي من دحين."
          : "Go to the gym now if you can after dinner.";
      args.onToken?.(text);
      return { role: "assistant", content: text, tokens: 3 };
    },
  };
  const app = await createApp({ dataDirectory: dir, ollama: fake });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  async function chat(text, chatId) {
    const res = await fetch(base + "/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CoffeeJack-Token": app.token,
      },
      body: JSON.stringify({ text, chatId }),
    });
    const events = (await res.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    let reply = "";
    for (const e of events) {
      if (e.type === "token") reply += e.text || "";
      if (e.type === "revise") reply = e.text == null ? reply : e.text;
    }
    return {
      chatId: events.find((e) => e.type === "chat")?.chat?.id || chatId,
      render: events.find((e) => e.type === "jeddawi_render"),
      done: events.find((e) => e.type === "done"),
      reply,
    };
  }

  const setup = await chat(
    "من دحين كلمني جداوي طبيعي، زي واحد من جدة يعرفني.",
  );
  assert.equal(setup.done?.renderer_used, false);
  assert.equal(renderCalls, 0);

  const r = await chat("ايش رايك اروح النادي؟", setup.chatId);
  assert.equal(renderCalls, 1, "renderer must run exactly once on guard fail");
  assert.equal(r.done?.jeddawi_renderer_fallback, true);
  assert.equal(r.done?.renderer_used, true);
  assert.ok(r.done?.jeddawi_fallback_reason);
  assert.doesNotMatch(r.reply, FORBIDDEN_EGYPTIAN);
  assert.match(r.reply, /دحين|روح/);
});
