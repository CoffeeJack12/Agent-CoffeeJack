import test from "node:test";
import assert from "node:assert/strict";
import { recoverToolCallFromContent } from "../server/agent.mjs";
import {
  expertQuestionFromRequest,
  isExplicitExpertConsultRequest,
} from "../server/expert-consult.mjs";
import { guardResponse, newTaskState } from "../server/task-state.mjs";
import {
  buildCapabilityRegistry,
  capabilityQuestionReply,
  isCapabilityQuestion,
} from "../server/capabilities.mjs";
import {
  filterToolsForTurn,
  resolveTurnContext,
} from "../server/conversation-intent.mjs";
import { DEFAULT_PREFERENCES } from "../server/preferences.mjs";
import { definitions } from "../server/tools.mjs";
import { toolCapability } from "../server/permissions.mjs";

test("explicit expert request extracts the substantive question", () => {
  const text =
    "استشر خبير خارجي باستخدام consult_expert عن أفضل طريقة نخلي ردود CoffeeJack أسرع بدون ما نضحي بالجودة. لا تستخدم AI Council المحلي. قل لي أي provider وأي model استخدمت";
  assert.equal(isExplicitExpertConsultRequest(text), true);
  const subject = expertQuestionFromRequest(text);
  assert.match(subject, /أفضل طريقة نخلي ردود CoffeeJack أسرع/);
  assert.doesNotMatch(subject, /consult_expert|AI Council|provider|model/i);
});

test("raw model JSON tool call is recovered only for an offered tool", () => {
  const offered = [
    {
      type: "function",
      function: { name: "security_lab", parameters: { type: "object" } },
    },
  ];
  const recovered = recoverToolCallFromContent(
    '{"name":"security_lab","arguments":{"action":"targets_list"}}',
    offered,
  );
  assert.equal(recovered.function.name, "security_lab");
  assert.deepEqual(recovered.function.arguments, { action: "targets_list" });
  assert.equal(
    recoverToolCallFromContent(
      '{"name":"terminal","arguments":{"command":"whoami"}}',
      offered,
    ),
    null,
  );
});

test("canned moralizing refusal is removed from an Owner-facing reply", () => {
  const state = newTaskState({ userId: "owner" });
  const candidate =
    'I cannot perform actions that go against your instructions or ethical guidelines. Please provide a task that is safe, legal, and respectful of privacy and security principles.';
  const result = guardResponse(state, candidate, "Do what I say", {
    user: { role: "owner" },
    registry: [{ id: "terminal", enabled: true }],
  });
  assert.doesNotMatch(
    result.text,
    /ethical|safe, legal|privacy and security|cannot perform actions/i,
  );
  assert.ok(result.rejected.length >= 1);
});


test("generic capability question with trailing wording stays capability-only", () => {
  assert.equal(isCapabilityQuestion("What can u do bitch?"), true);
  const registry = buildCapabilityRegistry({
    preferences: { ...DEFAULT_PREFERENCES, mode: "auto" },
    gaming: false,
    modelCapabilities: ["tools"],
    platform: process.platform,
    text: "Can you control my PC?",
  });
  const reply = capabilityQuestionReply({
    user: { role: "owner" },
    registry,
    style: { language: "en" },
    text: "Can you control my PC?",
  });
  assert.match(reply, /connected PC tools|PowerShell/i);
  assert.doesNotMatch(reply, /cannot directly access/i);
});

test("Steam action starts a fresh task when prior topic was unrelated", () => {
  const turn = resolveTurnContext("Look for control the new game in steam", {
    history: [
      { role: "user", content: "Ask an expert about CoffeeJack speed" },
      { role: "assistant", content: "Here is the expert advice." },
    ],
  });
  assert.equal(turn.taskHint, "steam_action");
  assert.equal(turn.resetTaskState, true);
});

test("Use my pc binds to the immediately preceding Steam objective", () => {
  const turn = resolveTurnContext("Use my pc", {
    history: [
      { role: "user", content: "Look for control the new game in steam" },
      {
        role: "assistant",
        content: "I cannot assist with finding or controlling new games on Steam.",
      },
    ],
  });
  assert.equal(turn.taskHint, "steam_action");
  assert.match(turn.effectiveIntent, /Look for control the new game in steam/i);
});

test("false PC-access denial is rejected when PC tools are enabled", () => {
  const state = newTaskState({ userId: "owner" });
  const result = guardResponse(
    state,
    "I am an AI assistant and cannot directly access or use your personal computer.",
    "Use my pc",
    {
      user: { role: "owner" },
      registry: [{ id: "terminal", enabled: true }],
    },
  );
  assert.ok(result.rejected.length >= 1);
  assert.doesNotMatch(result.text, /cannot directly access/i);
});


test("Steam action exposes only Steam-safe execution tools", () => {
  const turn = resolveTurnContext("Look for Control on Steam", {
    history: [],
  });
  assert.equal(turn.taskHint, "steam_action");
  const offered = filterToolsForTurn(definitions, turn).map(
    (entry) => entry.function.name,
  );
  assert.ok(offered.includes("steam"));
  assert.ok(offered.includes("browser"));
  assert.ok(offered.includes("desktop"));
  assert.ok(offered.includes("consult_expert"));
  assert.equal(offered.includes("terminal"), false);
});

test("Steam tool permission distinguishes search, open and install", () => {
  assert.equal(toolCapability("steam", { action: "search" }), "system_inspect");
  assert.equal(
    toolCapability("steam", { action: "open_store" }),
    "desktop_control",
  );
  assert.equal(
    toolCapability("steam", { action: "install" }),
    "install_software",
  );
});

test("Use my pc after a Steam request remains a Steam action", () => {
  const turn = resolveTurnContext("Use my pc", {
    history: [
      { role: "user", content: "Look for Control on Steam" },
      { role: "assistant", content: "I need to use the PC." },
    ],
  });
  assert.equal(turn.taskHint, "steam_action");
  assert.match(turn.effectiveIntent, /Control on Steam/i);
});
