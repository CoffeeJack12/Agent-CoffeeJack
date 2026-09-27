/**
 * Pre-routing context resolution + turn-scoped evidence regressions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveTurnContext,
  shouldAttachVerification,
  eventsForCurrentTurn,
  latestEventId,
  filterToolsForTurn,
  classifyConversationIntent,
} from "../server/conversation-intent.mjs";
import { buildEvidencePack } from "../server/council.mjs";
import { classifyTask } from "../server/router.mjs";
import { resolveEffectiveMode } from "../server/auto-mode.mjs";

const defs = [
  { function: { name: "research" } },
  { function: { name: "web_search" } },
  { function: { name: "remember" } },
  { function: { name: "search_code" } },
  { function: { name: "read_file" } },
];

test("A: yea resolves to previous memory-improvement proposal without research/verification", () => {
  const history = [
    {
      role: "assistant",
      content: "I can improve your memory system if you want.",
    },
  ];
  const turn = resolveTurnContext("yea", { history });
  assert.equal(turn.intent, "confirm");
  assert.match(turn.effectiveIntent, /memory system/i);
  assert.equal(turn.allowResearch, false);
  assert.equal(turn.allowVerification, false);
  assert.equal(turn.allowRememberTool, false);
  assert.equal(turn.allowMemoryWrite, false);
  assert.equal(
    shouldAttachVerification({
      intent: turn,
      text: "yea",
      evidencePack: {
        meaningful: true,
        research: { sources: [{ title: "x", url: "https://x.test" }] },
      },
      allowVerification: turn.allowVerification,
    }),
    false,
  );
  const mode = resolveEffectiveMode({
    text: turn.effectiveIntent,
    history,
  });
  assert.notEqual(mode.effectiveMode, "research");
  assert.equal(
    filterToolsForTurn(defs, turn).some((d) => d.function.name === "research"),
    false,
  );
});

test("B: do it continues previous proposal and does not open independent research", () => {
  const history = [
    {
      role: "assistant",
      content: "I can improve your memory system if you want.",
    },
    { role: "user", content: "yea" },
    {
      role: "assistant",
      content: "Great — I can start simplifying retrieval next.",
    },
  ];
  const turn = resolveTurnContext("do it", { history });
  assert.equal(turn.intent, "confirm");
  assert.match(turn.effectiveIntent, /simplifying retrieval|memory|proposal/i);
  assert.equal(turn.allowWebSearch, false);
  assert.equal(turn.allowResearch, false);
  assert.match(turn.directive, /Do not start unrelated web research/i);
});

test("C: الثاني أفضل selects option 2 without web search or verification", () => {
  const history = [
    {
      role: "assistant",
      content:
        "Option 1: Keep a dense memory index.\nOption 2: Use a simpler summary store.\nWhich do you prefer?",
    },
  ];
  const turn = resolveTurnContext("الثاني أفضل", { history });
  assert.equal(turn.intent, "select_option");
  assert.equal(turn.selectKey, "2");
  assert.match(turn.effectiveIntent, /option 2|simpler summary/i);
  assert.equal(turn.allowResearch, false);
  assert.equal(turn.allowVerification, false);
});

test("D: ابغاك تعدلها وتخليها أبسط is rewrite-only — no remember, no search", () => {
  const history = [
    {
      role: "assistant",
      content:
        "Here is a long explanation of AI memory systems with many details...",
    },
  ];
  const turn = resolveTurnContext("ابغاك تعدلها وتخليها أبسط", { history });
  assert.equal(turn.intent, "rewrite");
  assert.equal(turn.allowResearch, false);
  assert.equal(turn.allowRememberTool, false);
  assert.equal(turn.allowMemoryWrite, false);
  assert.equal(turn.allowVerification, false);
  const tools = filterToolsForTurn(defs, turn).map((d) => d.function.name);
  assert.ok(!tools.includes("remember"));
  assert.ok(!tools.includes("research"));
  assert.ok(!tools.includes("web_search"));
});

test("E: prior research events do not attach to a later unrelated coding turn", () => {
  const events = [
    {
      id: 1,
      chat_id: "c1",
      tool: "research",
      status: "done",
      created: "2026-01-01T00:00:00.000Z",
      detail: JSON.stringify({
        result: {
          sources: [{ title: "AI memory", url: "https://old.example/memory" }],
        },
      }),
    },
    {
      id: 2,
      chat_id: "c1",
      tool: "search_code",
      status: "done",
      created: "2026-01-01T01:00:00.000Z",
      detail: JSON.stringify({ result: { matches: ["bug"] } }),
    },
  ];
  const priorId = latestEventId([events[0]]);
  const turnEvents = eventsForCurrentTurn(events, {
    chatId: "c1",
    afterId: priorId,
  });
  assert.equal(turnEvents.length, 1);
  assert.equal(turnEvents[0].tool, "search_code");
  const pack = buildEvidencePack(turnEvents, { chatId: "c1" });
  assert.equal(pack.research?.sources?.length || 0, 0);
  assert.equal(pack.meaningful, false);
  assert.equal(
    shouldAttachVerification({
      text: "Find the bug in this function and explain why it happens",
      evidencePack: pack,
      allowVerification: true,
      turnScoped: true,
    }),
    false,
  );
});

test("F: coding bug request stays developer/coding without unrelated verification", () => {
  const text = "Find the bug in this function and explain why it happens";
  const turn = resolveTurnContext(text, { history: [] });
  assert.equal(turn.intent, "task");
  assert.equal(turn.allowResearch, true); // allowed, but not forced
  assert.equal(classifyTask({ text }), "coding");
  const mode = resolveEffectiveMode({ text });
  assert.equal(mode.effectiveMode, "developer");
  // Empty turn-scoped pack → no footer even if allowVerification.
  assert.equal(
    shouldAttachVerification({
      intent: turn,
      text,
      evidencePack: { meaningful: false },
      allowVerification: true,
    }),
    false,
  );
});

test("confirm intent still classifies for back-compat helpers", () => {
  const intent = classifyConversationIntent("sure", {
    history: [{ role: "assistant", content: "Shall I patch the file?" }],
  });
  assert.equal(intent.intent, "confirm");
  assert.equal(intent.conversational, true);
});
