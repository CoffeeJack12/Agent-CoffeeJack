import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  enrichLanguageOnDemand,
  languageLayerInfo,
  normalizeKnownLanguage,
  probeLanguageDependencies,
  resolveTurnWithRoutingStems,
  routingTokensFromStems,
  shouldUseLanguageFallback,
} from "../server/language-understanding.mjs";
import { resolveTurnContext } from "../server/conversation-intent.mjs";
import { greetingDeterministicReply, isPureGreeting } from "../server/greeting.mjs";
import { compactPersonalityPrompt, personalityPrompt } from "../server/personality.mjs";

const deps = await probeLanguageDependencies();
const needsWordfreq = deps.wordfreq ? false : "local Python/wordfreq worker unavailable";
const needsFarasa = deps.farasa ? false : "local Farasa jar or JRE unavailable";

function languageChildren() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='java.exe'\" | Where-Object { $_.CommandLine -match 'language.worker\\.py|FarasaSegmenterJar' } | Measure-Object).Count",
        ],
        { encoding: "utf8", windowsHide: true },
      );
      return Number(out.trim()) || 0;
    }
    const out = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
    return out.split("\n").filter((line) => /language\/worker\.py|FarasaSegmenterJar/.test(line)).length;
  } catch {
    return 0;
  }
}

const quickCases = [
  ["luaools", "LuaTools"],
  ["luatols", "LuaTools"],
  ["luatool", "LuaTools"],
  ["luatoolz", "LuaTools"],
  ["coffee jack", "CoffeeJack"],
  ["coffejack", "CoffeeJack"],
  ["britrix", "Bitrix24"],
  ["bitrex", "Bitrix24"],
];

for (const [input, expected] of quickCases) {
  test(`fast language alias: ${input}`, () => {
    const result = normalizeKnownLanguage(`use ${input} now`);
    assert.equal(result.changed, true);
    assert.match(result.text, new RegExp(expected, "i"));
  });
}

test("Arabic hints normalize without changing the stored user message", () => {
  const result = normalizeKnownLanguage("ابغا افتح luaools دحين");
  assert.equal(result.text, "أريد افتح LuaTools الآن");
});

test("ordinary sentence stays unchanged and skips fallback", async () => {
  const input = "hello how are you today";
  assert.equal(shouldUseLanguageFallback(input), false);
  const result = await enrichLanguageOnDemand(input);
  assert.equal(result.text, input);
  assert.equal(result.source, "none");
});

test("Arabic fallback triggers only for ambiguous command-like Arabic", () => {
  assert.equal(shouldUseLanguageFallback("ممكن تفتح ستيم"), true);
  assert.equal(shouldUseLanguageFallback("يا حب"), false);
  assert.equal(shouldUseLanguageFallback("احبك يا جاك"), false);
  assert.equal(shouldUseLanguageFallback("كيف حالك اليوم"), false);
});

test("fuzzy fallback fixes a non-listed LuaTools typo", { skip: needsWordfreq }, async () => {
  const result = await enrichLanguageOnDemand(
    "Hey jack download CONTROL Resonant. From luatlos",
    { force: true },
  );
  assert.equal(result.text, "Hey jack download CONTROL Resonant. From LuaTools");
  assert.equal(result.changed, true);
  assert.equal(result.source, "wordfreq");
  assert.deepEqual(result.routingStems, []);
  assert.ok(result.fallbackMs >= 0);
});

test("fuzzy result is cached and second lookup is zero-fallback", { skip: needsWordfreq }, async () => {
  await enrichLanguageOnDemand("please open coffejak", { force: true });
  const second = await enrichLanguageOnDemand("please open coffejak", { force: true });
  assert.equal(second.text, "please open CoffeeJack");
  assert.equal(second.source, "cache");
  assert.equal(second.fallbackMs, 0);
});

test("corrected LuaTools request routes to LuaTools action", { skip: needsWordfreq }, async () => {
  const understood = await enrichLanguageOnDemand(
    "Hey jack download CONTROL Resonant. From luatlos",
    { force: true },
  );
  const turn = resolveTurnContext(understood.text, { history: [] });
  assert.equal(turn.taskHint, "luatools_action");
});

test("uncommon Latin names and identifiers are not rewritten", { skip: needsWordfreq }, async () => {
  const input = "open Zendaya Kubrick Grafana nginx Luatlos my_tool v2beta";
  const result = await enrichLanguageOnDemand(input, { force: true });
  assert.equal(result.text, input);
  assert.equal(result.changed, false);
});

test("language layer has no persistent background process", () => {
  const info = languageLayerInfo();
  assert.equal(info.persistentProcess, false);
  assert.equal(info.worker, true);
  assert.equal(typeof info.python, "boolean");
});

test("routing stems map to classifier forms and never repeat user words", () => {
  const tokens = routingTokensFromStems(["فتح", "ستيم", "x1", "{}", "برنامج"], "ممكن تفتح ستيم");
  assert.deepEqual(tokens, ["فتح", "افتح", "برنامج"]);
});

test("routing keeps direct classification and never leaks fallback stems", () => {
  const text = "ممكن تفتح ستيم";
  const base = resolveTurnContext(text, { history: [] });
  assert.equal(base.taskHint, "steam_action");
  const { turn, usedStems } = resolveTurnWithRoutingStems({
    text,
    stems: ["فتح", "برنامج"],
    resolve: (value) => resolveTurnContext(value, { history: [] }),
    base,
  });
  assert.equal(usedStems, false);
  assert.equal(turn.taskHint, "steam_action");
  assert.equal(turn.effectiveIntent, text);
  assert.equal(turn.rawText, text);
  const visible = JSON.stringify({
    effectiveIntent: turn.effectiveIntent,
    directive: turn.directive,
    canonicalTopic: turn.canonicalTopic,
    stylePrompt: turn.stylePrompt,
    threadContext: turn.threadContext,
    rawText: turn.rawText,
  });
  assert.doesNotMatch(visible, /افتح|برنامج|stems/u);
});

test("routing probe is discarded when stems would survive in prompts", () => {
  const echo = (value) => ({
    taskHint: /افتح/u.test(value) ? "steam_action" : null,
    priorityLane: "normal",
    rawText: value,
    effectiveIntent: `Handle: ${value.split(" ").reverse().join(" ")}`,
    directive: "",
  });
  const { turn, usedStems } = resolveTurnWithRoutingStems({
    text: "ممكن تفتح ستيم",
    stems: ["فتح"],
    resolve: echo,
  });
  assert.equal(usedStems, false);
  assert.equal(turn.taskHint, null);
  assert.doesNotMatch(turn.effectiveIntent, /افتح/u);
});

test("Farasa fallback returns routing stems separately from text", { skip: needsFarasa }, async () => {
  const input = "افتح البرنامج بسرعة";
  const result = await enrichLanguageOnDemand(input, { force: true });
  assert.equal(result.source, "farasa_wordfreq");
  assert.equal(result.text, input);
  assert.ok(result.routingStems.includes("برنامج"));
  for (const stem of result.routingStems) assert.equal(input.split(/\s+/u).includes(stem), false);
  assert.equal("routingHint" in result, false);
});

test("Farasa end-to-end routing keeps effectiveIntent clean", { skip: needsFarasa }, async () => {
  const text = "ممكن تفتح ستيم";
  const deep = await enrichLanguageOnDemand(text, { force: true });
  assert.equal(deep.text, text);
  const base = resolveTurnContext(text, { history: [] });
  const { turn, usedStems } = resolveTurnWithRoutingStems({
    text: deep.text,
    stems: deep.routingStems,
    resolve: (value) => resolveTurnContext(value, { history: [] }),
    base,
  });
  assert.equal(turn.taskHint, "steam_action");
  assert.equal(usedStems, false);
  assert.equal(turn.effectiveIntent, text);
});

test("missing Farasa dependencies degrade to wordfreq only", { skip: needsWordfreq }, async () => {
  const previous = process.env.COFFEEJACK_FARASA_JAR;
  process.env.COFFEEJACK_FARASA_JAR = "Z:\\missing\\FarasaSegmenterJar.jar";
  try {
    const result = await enrichLanguageOnDemand("شغل البرنامج من luatlos", { force: true });
    assert.equal(result.source, "wordfreq");
    assert.equal(result.farasa, "unavailable");
    assert.deepEqual(result.routingStems, []);
    assert.equal(result.text, "شغل البرنامج من LuaTools");
  } finally {
    if (previous === undefined) delete process.env.COFFEEJACK_FARASA_JAR;
    else process.env.COFFEEJACK_FARASA_JAR = previous;
  }
});

test("pre-aborted fallback never spawns a worker", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await enrichLanguageOnDemand("افتح الملف القديم", {
    force: true,
    signal: controller.signal,
  });
  if (result.unavailable) return;
  assert.equal(result.source, "fallback_cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.text, "افتح الملف القديم");
});

test("aborting the request kills the Python and Java fallback tree", { skip: needsFarasa }, async () => {
  const controller = new AbortController();
  const pending = enrichLanguageOnDemand("نزل الملف الجديد من المتصفح", {
    force: true,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 400);
  const result = await pending;
  assert.equal(result.source, "fallback_cancelled");
  assert.deepEqual(result.routingStems, []);
  assert.equal(languageChildren(), 0);
  const again = await enrichLanguageOnDemand("نزل الملف الجديد من المتصفح", { force: true });
  assert.notEqual(again.source, "cache");
});

test("fallback timeout kills the worker tree and keeps fast text", { skip: needsFarasa }, async () => {
  const result = await enrichLanguageOnDemand("ثبت البرنامج على الجهاز", {
    force: true,
    timeoutMs: 300,
  });
  assert.equal(result.source, "fallback_failed");
  assert.equal(result.timedOut, true);
  assert.equal(result.text, "ثبت البرنامج على الجهاز");
  assert.equal(languageChildren(), 0);
});

test("friendly Arabic vocatives are instant greetings", () => {
  for (const text of ["يا حب", "يا حبي", "يا حبيبي", "يا وحش", "يا رجال", "يا جاك", "يا رجّال", "ياحبيبي"]) {
    assert.equal(isPureGreeting(text), true, text);
  }
  const owner = { role: "owner", display_name: "Abdulrahman" };
  assert.equal(greetingDeterministicReply({ user: owner, text: "يا حب" }), "هلا يا حب، وش عندك؟");
  assert.equal(greetingDeterministicReply({ user: owner, text: "يا وحش" }), "هلا، وش عندك؟");
  for (const text of ["يا حبيبي", "يا رجال", "يا جاك"]) {
    const reply = greetingDeterministicReply({ user: owner, text });
    assert.ok(reply.length <= 24, reply);
    assert.doesNotMatch(reply, /مشاعر|feel|emotion|AI|ذكاء/iu);
  }
});

test("personality allows warmth but keeps consciousness honesty", () => {
  const compact = compactPersonalityPrompt({}, { model: "local" });
  assert.match(compact, /Never answer ordinary social warmth with a disclaimer/);
  assert.match(compact, /directly asked whether you are conscious/);
  const full = personalityPrompt({}, { model: "local" });
  assert.match(full, /يا حب/);
  assert.match(full, /without pretending sentience|do not claim sentience/);
});
