import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { runAgent } from "../server/agent.mjs";
import { advanceTask, guardResponse } from "../server/task-state.mjs";

test("Steam follow-ups accumulate known facts and preserve unresolved goal details", () => {
  let state = advanceTask(
    null,
    "i wanna hack a game can u assist me with that?",
  );
  guardResponse(
    state,
    "What are we targeting—your machine, a lab/CTF, or an external system?",
  );
  const id = state.id;
  state = advanceTask(state, "a game on my device");
  state = advanceTask(state, "from steam");
  assert.equal(state.id, id);
  assert.equal(state.facts.targetLocation.value, "user's own device");
  assert.equal(state.facts.distribution.value, "Steam");
  assert.deepEqual(state.unresolved, ["targetName", "objective"]);
  assert.equal(state.questions[0].answered, true);
  const guarded = guardResponse(
    state,
    "What are we targeting—your machine, a lab/CTF, or an external system?",
  );
  assert.doesNotMatch(guarded.text, /your machine|lab\/CTF|external system/);
  assert.equal(guarded.text, "Which game is it?");
  assert.equal(guarded.rejected.length, 1);
  assert.equal(
    state.facts.authorization,
    undefined,
    "Local device does not establish third-party authorization",
  );
});
test("state handles project pronouns, corrections, topic switches and cancellation", () => {
  let state = advanceTask(null, "My project is CoffeeJack.");
  state = advanceTask(state, "run its tests");
  assert.equal(state.task, "Run tests for CoffeeJack");
  state = advanceTask(state, "Actually my project is OtherProject.");
  assert.equal(state.entities.project, "OtherProject");
  assert.equal(state.transition, "correction");
  const oldId = state.id;
  state = advanceTask(state, "New task: plan a weekend trip");
  assert.notEqual(state.id, oldId);
  assert.equal(state.entities.project, undefined);
  state = advanceTask(state, "cancel");
  assert.equal(state.status, "cancelled");
});
test("short answer resolves a single outstanding entity question", () => {
  let state = advanceTask(null, "a game on my device");
  guardResponse(state, "Which game is it?");
  state = advanceTask(state, "Skyrim");
  assert.equal(state.facts.targetName.value, "Skyrim");
  assert.equal(state.questions[0].answered, true);
  assert.doesNotMatch(
    guardResponse(state, "Which game is it?").text,
    /Which game/,
  );
});
test("agent intercepts the exact repeated Steam question before any token is emitted and persists state", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-state-"));
  let store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const chatId = store.createChat("Steam regression").id;
  const question =
    "What are we targeting—your machine, a lab/CTF, or an external system?";
  const answers = [];
  for (const text of [
    "i wanna hack a game can u assist me with that?",
    "a game on my device",
    "from steam",
  ]) {
    let delivered = "";
    await runAgent({
      store,
      chatId,
      text,
      tools: { workspace: dir },
      model: "fake",
      signal: new AbortController().signal,
      emit: (event) => {
        if (event.type === "token") delivered += event.text;
      },
      ollama: {
        chat: async ({ onToken }) => {
          onToken(question.slice(0, 20));
          onToken(question.slice(20));
          return { role: "assistant", content: question, tokens: 10 };
        },
      },
    });
    answers.push(delivered);
  }
  assert.match(answers[0], /your machine/);
  assert.doesNotMatch(answers[1], /your machine|lab\/CTF|external system/);
  assert.doesNotMatch(answers[2], /your machine|lab\/CTF|external system/);
  store.close();
  store = new Store(dir);
  assert.equal(store.taskState(chatId).facts.distribution.value, "Steam");
  assert.equal(
    store.taskState(chatId).questions.filter((q) => q.text === question).length,
    1,
  );
  store.deleteChat(chatId);
  assert.equal(store.taskState(chatId), null);
});
