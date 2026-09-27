import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Tools, definitions } from "../server/tools.mjs";
import { Store } from "../server/store.mjs";
import { runAgent } from "../server/agent.mjs";

function makeTools(approvals) {
  return new Tools({
    root: process.cwd(),
    workspace: process.cwd(),
    approve: async (name, args) => approvals.push({ name, args }),
  });
}

test("LuaTools read-only actions do not request approval", async () => {
  const approvals = [];
  const tools = makeTools(approvals);
  const signal = new AbortController().signal;
  await tools.execute("luatools", { action: "status" }, signal);
  await tools.execute("luatools", { action: "inventory" }, signal);
  assert.deepEqual(approvals, []);
});

test("LuaTools exposes the evidence-first read-only actions", () => {
  const def = definitions.find((item) => item.function?.name === "luatools");
  const actions = def.function.parameters.properties.action.enum;
  for (const action of ["status", "inventory", "inspect_app", "inspect_artifacts", "verify_state"])
    assert.ok(actions.includes(action), action);
});

test("verified LuaTools inspection ends the turn after one successful call", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-luatools-agent-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const chatId = store.createChat("luatools live regression").id;
  let modelCalls = 0;
  let toolCalls = 0;
  let output = "";
  const ollama = {
    chat: async () => {
      modelCalls++;
      return {
        role: "assistant",
        content: "",
        tokens: 1,
        tool_calls: [{
          function: {
            name: "luatools",
            arguments: { action: "inspect_app", app_id: 2825860 },
          },
        }],
      };
    },
  };
  const tools = {
    workspace: dir,
    execute: async (name, args) => {
      toolCalls++;
      assert.equal(name, "luatools");
      assert.equal(args.action, "inspect_app");
      assert.equal(args.app_id, 2825860);
      return {
        action: "inspect_app",
        app_id: 2825860,
        appmanifest: { name: "The Sinking City 2", buildid: "24867144" },
        settings: { selected_mode: "Bst" },
        verification: {
          app_id: 2825860,
          lua_present: true,
          appmanifest_present: true,
          completed_history_present: true,
          history_reveal_matches_active: true,
          vault_hash_matches_active: true,
          installed_depot_manifest_count: 1,
          missing_installed_depot_manifests: [],
          plugin_present: true,
          selected_mode: "Bst",
          verified: true,
        },
      };
    },
  };
  await runAgent({
    store,
    ollama,
    tools,
    chatId,
    text: "Use LuaTools to inspect The Sinking City 2, App ID 2825860, and verify it.",
    model: "test",
    signal: new AbortController().signal,
    emit: (e) => {
      if (e.type === "token") output += e.text;
    },
    turnPolicy: {
      taskHint: "luatools_action",
      effectiveIntent: "Use LuaTools to inspect App ID 2825860 and verify it.",
      snapshot: { lastUser: "" },
    },
  });
  assert.equal(modelCalls, 1);
  assert.equal(toolCalls, 1);
  assert.match(output, /Verified locally through LuaTools/);
  assert.match(output, /The Sinking City 2/);
  assert.match(output, /App ID 2825860/);
  assert.equal(store.taskState(chatId).status, "completed");
});

test("LuaTools download request stops cleanly instead of dumping inventory JSON", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-luatools-download-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const chatId = store.createChat("luatools download regression").id;
  let modelCalls = 0;
  let toolCalls = 0;
  let output = "";
  await runAgent({
    store,
    ollama: { chat: async () => { modelCalls++; throw new Error("model must not run"); } },
    tools: { workspace: dir, execute: async () => { toolCalls++; return {}; } },
    chatId,
    text: "Hey jack download CONTROL Resonant. From luaools",
    model: "test",
    signal: new AbortController().signal,
    emit: (e) => { if (e.type === "token") output += e.text; },
    turnPolicy: {
      taskHint: "luatools_action",
      effectiveIntent: "Hey jack download CONTROL Resonant. From luaools",
      snapshot: { lastUser: "" },
    },
  });
  assert.equal(modelCalls, 0);
  assert.equal(toolCalls, 0);
  assert.match(output, /No download was started/);
  assert.match(output, /Missing action: luatools\.download\/install/);
  assert.doesNotMatch(output, /depot_id|manifest_id|you've shared/i);
  assert.equal(store.taskState(chatId).status, "incomplete");
});
