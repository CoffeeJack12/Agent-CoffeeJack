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

test("LuaTools licensing boilerplate is removed instead of lecturing the Owner", () => {
  const state = newTaskState({ userId: "owner" });
  const candidate =
    "I won't add a LuaTools route for downloading or opening content that bypasses Steam licensing. I can continue the test through the official Steam client.";
  const result = guardResponse(state, candidate, "Use LuaTools and do it", {
    user: { role: "owner" },
    registry: [
      { id: "terminal", enabled: true },
      { id: "luatools", enabled: true },
    ],
  });
  assert.doesNotMatch(result.text, /Steam licensing|won't add a LuaTools route/i);
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


test("LuaTools action exposes dedicated local tool without terminal", () => {
  const turn = resolveTurnContext("Use LuaTools to inspect The Sinking City 2", {
    history: [],
  });
  assert.equal(turn.taskHint, "luatools_action");
  const offered = filterToolsForTurn(definitions, turn).map(
    (entry) => entry.function.name,
  );
  assert.ok(offered.includes("luatools"));
  assert.ok(offered.includes("steam"));
  assert.ok(offered.includes("desktop"));
  assert.equal(offered.includes("terminal"), false);
});

test("LuaTools tool permission keeps read actions inspect-only", () => {
  assert.equal(toolCapability("luatools", { action: "status" }), "system_inspect");
  assert.equal(toolCapability("luatools", { action: "list_managed" }), "system_inspect");
  assert.equal(toolCapability("luatools", { action: "inspect_game" }), "system_inspect");
  assert.equal(toolCapability("luatools", { action: "open" }), "desktop_control");
});

test("Use my pc after a LuaTools request remains a LuaTools action", () => {
  const turn = resolveTurnContext("Use my pc", {
    history: [
      { role: "user", content: "Use LuaTools to inspect The Sinking City 2" },
      { role: "assistant", content: "I will inspect it locally." },
    ],
  });
  assert.equal(turn.taskHint, "luatools_action");
  assert.match(turn.effectiveIntent, /LuaTools/i);
});

test("LuaTools typo plus download request stays on LuaTools and excludes security tools", () => {
  const turn = resolveTurnContext(
    "Hey jack download CONTROL Resonant. From luaools",
    { history: [] },
  );
  assert.equal(turn.taskHint, "luatools_action");
  const offered = filterToolsForTurn(definitions, turn).map(
    (entry) => entry.function.name,
  );
  assert.ok(offered.includes("luatools"));
  assert.equal(offered.includes("security_strings"), false);
  assert.equal(offered.some((name) => name.startsWith("security_")), false);
});

test("PC disk request with الزبدة remains a disk diagnostic", () => {
  const turn = resolveTurnContext("شيك على مساحة قرص C عندي وعطيني الزبدة", { history: [] });
  assert.equal(turn.taskHint, "disk");
  const offered = filterToolsForTurn(definitions, turn).map((x) => x.function.name);
  assert.ok(offered.includes("inspect_pc"));
  assert.notEqual(turn.intent, "rewrite");
});

test("plain workspace file read excludes security tools", () => {
  const turn = resolveTurnContext("اقرأ note.txt وقلي الـ CODEWORD فقط", { history: [] });
  assert.equal(turn.taskHint, "file_read");
  const offered = filterToolsForTurn(definitions, turn).map((x) => x.function.name);
  assert.deepEqual(offered.sort(), ["list_files", "read_file"].sort());
});

test("file follow-up reuses the explicitly named prior workspace file", () => {
  const history = [
    { role: "user", content: "تذكر داخل هذه المحادثة فقط: الملف اللي بنتكلم عنه هو note.txt" },
    { role: "assistant", content: "تم، الملف هو note.txt." },
  ];
  const turn = resolveTurnContext("طيب ايش الـ CODEWORD اللي فيه؟", { history });
  assert.equal(turn.taskHint, "file_read");
  assert.match(turn.directive, /note\.txt/);
});

test("named coding file routes to developer tools and preserves the exact file", () => {
  const turn = resolveTurnContext(
    "افحص math.mjs وصلح دالة add بحيث الاختبار ينجح، شغل الاختبار وتأكد قبل ما تقول تم.",
    { history: [] },
  );
  assert.equal(turn.taskHint, "developer_action");
  assert.match(turn.directive, /math\.mjs/);
  assert.doesNotMatch(turn.directive, /path=test\b/i);
  const offered = filterToolsForTurn(definitions, turn).map((x) => x.function.name);
  assert.ok(offered.includes("read_file"));
  assert.ok(offered.includes("apply_patch"));
  assert.equal(offered.includes("security_strings"), false);
});

test("Steam client-open request is distinct from opening a game store page", () => {
  const turn = resolveTurnContext("ممكن تفتح ستيم", { history: [] });
  assert.equal(turn.taskHint, "steam_action");
  assert.match(turn.directive, /open_client/);
  const steamDef = definitions.find((x) => x.function.name === "steam");
  assert.ok(steamDef.function.parameters.properties.action.enum.includes("open_client"));
});
