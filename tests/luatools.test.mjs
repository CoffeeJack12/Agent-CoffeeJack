import test from "node:test";
import assert from "node:assert/strict";
import { Tools, definitions } from "../server/tools.mjs";

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
