import test from "node:test";
import assert from "node:assert/strict";
import {
  enrichLanguageOnDemand,
  languageLayerInfo,
  normalizeKnownLanguage,
  shouldUseLanguageFallback,
} from "../server/language-understanding.mjs";
import { resolveTurnContext } from "../server/conversation-intent.mjs";

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

test("fuzzy fallback fixes a non-listed LuaTools typo", async () => {
  const result = await enrichLanguageOnDemand(
    "Hey jack download CONTROL Resonant. From luatlos",
    { force: true },
  );
  assert.equal(result.text, "Hey jack download CONTROL Resonant. From LuaTools");
  assert.equal(result.changed, true);
  assert.equal(result.source, "wordfreq");
  assert.ok(result.fallbackMs >= 0);
});

test("fuzzy result is cached and second lookup is zero-fallback", async () => {
  await enrichLanguageOnDemand("please open coffejak", { force: true });
  const second = await enrichLanguageOnDemand("please open coffejak", { force: true });
  assert.equal(second.text, "please open CoffeeJack");
  assert.equal(second.source, "cache");
  assert.equal(second.fallbackMs, 0);
});

test("corrected LuaTools request routes to LuaTools action", async () => {
  const understood = await enrichLanguageOnDemand(
    "Hey jack download CONTROL Resonant. From luatlos",
    { force: true },
  );
  const turn = resolveTurnContext(understood.text, { history: [] });
  assert.equal(turn.taskHint, "luatools_action");
});

test("language layer has no persistent background process", () => {
  const info = languageLayerInfo();
  assert.equal(info.persistentProcess, false);
  assert.equal(info.python, true);
  assert.equal(info.worker, true);
});
