/**
 * Conversation context regression: fast path must not be stateless.
 * Real /api/chat multi-turn on one persistent chat session.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import {
  resolveTurnContext,
  extractTransientFacts,
  classifyLanguageSwitch,
  formatCompactThreadContext,
} from "../server/conversation-intent.mjs";

async function appFixture(t, { ollamaChat } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-ctx-"));
  const prompts = [];
  const fake = {
    models: async () => [{ name: "qwen3:8b" }, { name: "qwen3:14b" }],
    inspect: async () => ({ capabilities: ["tools"] }),
    prepare: async () => ({ alreadyLoaded: true, unloaded: [] }),
    unload: async () => [],
    chat: async (args) => {
      prompts.push(structuredClone(args.messages));
      if (typeof ollamaChat === "function") return ollamaChat(args, prompts);
      const lastUser = [...(args.messages || [])]
        .reverse()
        .find((m) => m.role === "user");
      const sys = args.messages?.find((m) => m.role === "system")?.content || "";
      let text = "Acknowledged.";
      if (
        /LANGUAGE SWITCH:\s*reply in Arabic|language=ar|STYLE \/ DIALECT/i.test(
          sys,
        ) &&
        /تكلم معايا عربي|عربي/i.test(lastUser?.content || "")
      )
        text = "حسناً، سأكمل بالعربية حول نفس الموضوع.";
      else if (
        /LANGUAGE SWITCH:\s*reply in English|language=en/i.test(sys) &&
        /انجليزي|English/i.test(lastUser?.content || "")
      )
        text = "Continuing in English on the same topic (purple).";
      else if (
        /favorite_color:\s*purple/i.test(sys) &&
        /what color|recall_recent|just tell you/i.test(
          lastUser?.content || "" + sys,
        )
      )
        text = "Purple.";
      else if (/Previous assistant reply to rewrite/i.test(sys))
        text = "Purple.";
      else if (/Do NOT reply with a fresh greeting/i.test(sys))
        text = "Understood — staying with purple for this chat.";
      else if (/favorite color for this conversation is purple/i.test(lastUser?.content || ""))
        text = "Got it — purple for this conversation.";
      args.onToken?.(text);
      return { role: "assistant", content: text, tokens: 4 };
    },
  };
  const app = await createApp({ dataDirectory: dir, ollama: fake });
  app.store.set("autoApprove", true);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, dir, prompts, store: app.store };
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
  const raw = await response.text();
  const events = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const reply = events
    .filter((e) => e.type === "token")
    .map((e) => e.text)
    .join("");
  const ctx = events.find((e) => e.type === "turn_context");
  const chatEvent = events.find((e) => e.type === "chat");
  const nextChatId = chatEvent?.chat?.id || chatId;
  return { status: response.status, events, reply, ctx, chatId: nextChatId };
}

test("unit: transient favorite color extracted; rewrite/language/recall classify", () => {
  const history = [
    {
      role: "user",
      content: "My favorite color for this conversation is purple.",
    },
    { role: "assistant", content: "Got it — purple for this chat." },
  ];
  const facts = extractTransientFacts(history);
  assert.equal(facts.some((f) => f.key === "favorite_color" && f.value === "purple"), true);

  const recall = resolveTurnContext("what color did i just tell you?", { history });
  assert.equal(recall.intent, "recall_recent");
  assert.equal(recall.fastPath, true);
  assert.match(recall.effectiveIntent, /purple/i);
  assert.match(recall.threadContext, /favorite_color: purple/i);

  const rewrite = resolveTurnContext("make your answer shorter", { history });
  assert.equal(rewrite.intent, "rewrite");
  assert.match(rewrite.directive, /Previous assistant reply/i);

  const yea = resolveTurnContext("yea", { history });
  assert.equal(yea.taskHint, "acknowledge");
  assert.match(yea.directive, /Do NOT reply with a fresh greeting/i);

  assert.equal(classifyLanguageSwitch("تكلم معايا عربي")?.language, "ar");
  assert.equal(classifyLanguageSwitch("كمل بالانجليزي")?.language, "en");
  const ar = resolveTurnContext("تكلم معايا عربي", { history });
  assert.ok(["language_switch", "style_switch"].includes(ar.intent));
  assert.match(ar.directive, /Preserve the active topic|Do NOT reset the active topic/i);
  assert.match(formatCompactThreadContext(ar.snapshot), /ACTIVE THREAD/);
});

test("unit: transient fact is not treated as executable proposal", () => {
  const history = [
    { role: "assistant", content: "Got it — I will use purple for this chat." },
  ];
  const yea = resolveTurnContext("yea", { history });
  assert.equal(yea.taskHint, "acknowledge");
  assert.doesNotMatch(yea.effectiveIntent, /continue\/execute/i);
});

test("unit: real proposal still confirms for execution", () => {
  const history = [
    {
      role: "assistant",
      content: "I can improve your memory system if you want.",
    },
  ];
  const yea = resolveTurnContext("yea", { history });
  assert.equal(yea.intent, "confirm");
  assert.equal(yea.taskHint, "confirm_action");
  assert.match(yea.effectiveIntent, /memory system/i);
});

test("API: multi-turn purple → recall → shorter → yea → ar → en on one chat", async (t) => {
  const { app, base, store, prompts } = await appFixture(t);

  const t1 = await chat(
    base,
    app.token,
    "My favorite color for this conversation is purple.",
  );
  assert.equal(t1.status, 200);
  const chatId = t1.chatId;
  assert.ok(chatId, "need persistent chat id");
  assert.match(t1.reply, /purple/i);

  const t2 = await chat(
    base,
    app.token,
    "what color did i just tell you?",
    chatId,
  );
  assert.equal(t2.status, 200);
  assert.equal(t2.chatId, chatId);
  assert.equal(t2.ctx?.intent, "recall_recent");
  assert.equal(t2.ctx?.fastPath, true);
  assert.ok(
    (t2.ctx?.transientFacts || []).some(
      (f) => f.key === "favorite_color" && /purple/i.test(f.value),
    ),
  );
  assert.match(t2.reply, /purple/i);
  const lastSys = prompts.at(-1)?.find((m) => m.role === "system")?.content || "";
  assert.match(lastSys, /ACTIVE THREAD|favorite_color|purple/i);
  assert.equal(
    store.relevantMemories("purple", { limit: 10 }).some((m) =>
      /purple/i.test(m.content),
    ),
    false,
    "transient color must not be long-term memory",
  );

  const t3 = await chat(base, app.token, "make your answer shorter", chatId);
  assert.equal(t3.ctx?.intent, "rewrite");
  assert.match(t3.ctx?.effectiveIntent || "", /Rewrite|simpler|shorter/i);

  const t4 = await chat(base, app.token, "yea", chatId);
  assert.equal(t4.ctx?.intent, "confirm");
  assert.doesNotMatch(t4.reply, /At your service/i);
  assert.match(t4.ctx?.effectiveIntent || "", /acknowledged|thread/i);

  const t5 = await chat(base, app.token, "تكلم معايا عربي", chatId);
  assert.ok(["language_switch", "style_switch"].includes(t5.ctx?.intent));
  assert.equal(t5.ctx?.conversationStyle?.language || t5.ctx?.languageSwitch?.language, "ar");
  assert.match(t5.reply, /[\u0600-\u06ff]/);

  const t6 = await chat(base, app.token, "كمل بالانجليزي", chatId);
  assert.ok(["language_switch", "style_switch"].includes(t6.ctx?.intent));
  assert.equal(
    t6.ctx?.conversationStyle?.language || t6.ctx?.languageSwitch?.language,
    "en",
  );
  assert.match(t6.ctx?.effectiveIntent || "", /English|continue|style/i);
  assert.ok(
    (t6.ctx?.transientFacts || []).some((f) => /purple/i.test(f.value)) ||
      t6.ctx?.conversationStyle,
    "topic/facts or style preserved across language switch",
  );
});

test("API: continue uses active thread; new topic stays task", async (t) => {
  const { app, base } = await appFixture(t);
  const first = await chat(
    base,
    app.token,
    "My favorite color for this conversation is purple.",
  );
  const chatId = first.chatId;
  assert.ok(chatId);

  const cont = resolveTurnContext("continue", {
    history: app.store.messages(chatId),
  });
  assert.equal(cont.intent, "continue");
  assert.match(cont.directive || "", /ACTIVE THREAD|Continue the same topic/i);

  const neu = resolveTurnContext("new topic: tell me a joke about cats", {
    history: app.store.messages(chatId),
  });
  assert.equal(neu.intent, "task");
});

test("fast-path latency budget: hey still skips tools/council (unit)", () => {
  const turn = resolveTurnContext("hey", { history: [] });
  assert.equal(turn.fastPath, true);
  assert.equal(turn.intent, "greeting");
});
