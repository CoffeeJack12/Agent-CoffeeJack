import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { runAgent } from "../server/agent.mjs";
import { advanceTask } from "../server/task-state.mjs";
import {
  preparePlan,
  recordExecution,
  evaluateFinal,
} from "../server/planner.mjs";

test("execution evidence survives continuation and edits invalidate previous verification", () => {
  let state = advanceTask(null, "fix a bug");
  preparePlan(state, "fix a bug");
  recordExecution(state, "read_file", { success: true });
  recordExecution(state, "apply_patch", { success: true });
  recordExecution(state, "run_tests", { success: true, code: 0 });
  assert.equal(evaluateFinal(state, "All tests passed.").ok, true);
  state = advanceTask(state, "continue");
  preparePlan(state, "continue");
  assert.equal(state.plan.find((s) => s.kind === "test").status, "completed");
  recordExecution(state, "apply_patch", { success: true });
  assert.equal(state.plan.find((s) => s.kind === "test").status, "pending");
  assert.equal(evaluateFinal(state, "Tests passed.").ok, false);
  recordExecution(state, "run_tests", { success: false, code: 1 });
  assert.equal(evaluateFinal(state, "Tests passed.").ok, false);
  recordExecution(state, "run_tests", { success: true, code: 0 });
  assert.equal(evaluateFinal(state, "Tests passed.").ok, true);
  assert.equal(state.failedStrategies.at(-1).resolved, true);
  state = advanceTask(state, "New task: fix another bug");
  assert.equal(state.toolsUsed.length, 0);
  assert.equal(evaluateFinal(state, "Tests passed.").ok, false);
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-plan-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const chatId = store.createChat("plan regression").id;
  let output = "";
  const base = {
    store,
    chatId,
    model: "fake",
    text: "run its tests",
    tools: {
      workspace: dir,
      execute: async () => ({ code: 0, output: "passed" }),
    },
    signal: new AbortController().signal,
    emit: (e) => {
      if (e.type === "token") output += e.text;
    },
  };
  return { base, store, chatId, output: () => output };
}
test("unsupported success is intercepted before emission and evaluator retries only once", async (t) => {
  const f = await fixture(t);
  let rounds = 0;
  await runAgent({
    ...f.base,
    ollama: {
      chat: async ({ onToken }) => {
        rounds++;
        onToken("All tests passed.");
        return { role: "assistant", content: "All tests passed." };
      },
    },
  });
  assert.equal(rounds, 2);
  assert.equal(
    f.output(),
    "I could not verify that the tests passed. The task still needs a successful test run.",
  );
  assert.equal(f.store.taskState(f.chatId).status, "incomplete");
});
test("evaluator allows a repair tool and verified success, persists the tool evidence", async (t) => {
  const f = await fixture(t);
  let rounds = 0;
  await runAgent({
    ...f.base,
    ollama: {
      chat: async () => {
        rounds++;
        if (rounds === 2)
          return {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "run_tests", arguments: {} } }],
          };
        return { role: "assistant", content: "All tests passed." };
      },
    },
  });
  assert.equal(rounds, 3);
  assert.equal(f.output(), "All tests passed.");
  assert.equal(f.store.taskState(f.chatId).toolsUsed.at(-1).code, 0);
});
test("cancellation avoids model and tools entirely", async (t) => {
  const f = await fixture(t);
  await runAgent({
    ...f.base,
    text: "cancel",
    ollama: {
      chat: async () => {
        throw Error("must not run");
      },
    },
  });
  assert.equal(f.output(), "Task cancelled.");
  assert.equal(f.store.taskState(f.chatId).status, "cancelled");
});

test("filtered tests and shell activity cannot justify a full-suite success claim", () => {
  const state = advanceTask(null, "fix bug");
  preparePlan(state, "fix bug");
  recordExecution(state, "run_tests", {
    success: true,
    code: 0,
    filtered: true,
  });
  assert.equal(evaluateFinal(state, "All tests passed.").ok, false);
  recordExecution(state, "run_tests", { success: true, code: 0 });
  recordExecution(state, "terminal", { success: true, code: 0 });
  assert.equal(evaluateFinal(state, "All tests passed.").ok, false);
});
test("workspace changes discard earlier verification evidence", async (t) => {
  const f = await fixture(t);
  const old = advanceTask(null, "fix bug", { project: "another-workspace" });
  recordExecution(old, "run_tests", { success: true, code: 0 });
  f.store.saveTaskState(f.chatId, old);
  let rounds = 0;
  await runAgent({
    ...f.base,
    ollama: {
      chat: async () => {
        rounds++;
        return { role: "assistant", content: "All tests passed." };
      },
    },
  });
  assert.equal(rounds, 2);
  assert.equal(f.store.taskState(f.chatId).toolsUsed.length, 0);
});

test("evaluator preserves honest uncertainty and quoted code examples", () => {
  const state = advanceTask(null, "explain tests");
  for (const text of [
    "I have not verified that tests passed.",
    "If all tests pass, commit the change.",
    "> All tests passed.",
    '```js\nconsole.log("tests passed");\n```',
  ])
    assert.equal(evaluateFinal(state, text).ok, true, text);
  assert.equal(evaluateFinal(state, "All tests passed.").ok, false);
});
