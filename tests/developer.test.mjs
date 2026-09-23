import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Tools } from "../server/tools.mjs";
import { runAgent } from "../server/agent.mjs";
import { Store } from "../server/store.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-dev-"));
  const approved = [];
  const tools = new Tools({
    root: dir,
    workspace: dir,
    approve: async (name) => approved.push(name),
  });
  const cleanup = [];
  t.after(async () => {
    for (const dispose of cleanup) await dispose();
    await tools.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    tools,
    approved,
    cleanup,
    signal: new AbortController().signal,
  };
}
test("apply_patch edits exact unique context, creates backup and rejects stale/ambiguous patches", async (t) => {
  const { dir, tools, approved, signal } = await fixture(t);
  await fs.writeFile(path.join(dir, "a.js"), "const x = 1;\n");
  await tools.execute(
    "apply_patch",
    { path: "a.js", oldText: "x = 1", newText: "x = 2" },
    signal,
  );
  assert.equal(
    await fs.readFile(path.join(dir, "a.js"), "utf8"),
    "const x = 2;\n",
  );
  const backup = (await fs.readdir(path.join(dir, ".local/backups")))[0];
  assert.equal(
    await fs.readFile(path.join(dir, ".local/backups", backup), "utf8"),
    "const x = 1;\n",
  );
  assert.deepEqual(approved, ["apply_patch"]);
  await assert.rejects(
    tools.execute(
      "apply_patch",
      { path: "a.js", oldText: "x = 1", newText: "bad" },
      signal,
    ),
    /no longer matches/,
  );
  await fs.writeFile(path.join(dir, "b.txt"), "same same");
  await assert.rejects(
    tools.execute(
      "apply_patch",
      { path: "b.txt", oldText: "same", newText: "bad" },
      signal,
    ),
    /ambiguous/,
  );
  await assert.rejects(
    tools.execute(
      "apply_patch",
      { path: "../escape", oldText: "a", newText: "b" },
      signal,
    ),
  );
  await assert.rejects(
    tools.execute(
      "apply_patch",
      { path: ".env", oldText: "a", newText: "b" },
      signal,
    ),
  );
});
test("developer writes and checks are cancelled after approval before execution", async (t) => {
  const { tools } = await fixture(t);
  const controller = new AbortController();
  tools.approve = async () => controller.abort();
  await assert.rejects(
    tools.execute(
      "apply_patch",
      { path: "a", oldText: "a", newText: "b" },
      controller.signal,
    ),
    /Cancelled/,
  );
});
test("project_map detects scripts without executing and skips protected paths and links", async (t) => {
  const { dir, tools, signal } = await fixture(t);
  await fs.mkdir(path.join(dir, "src"));
  await fs.mkdir(path.join(dir, ".local"));
  await fs.writeFile(path.join(dir, "src/a.js"), "hello");
  await fs.writeFile(path.join(dir, ".env"), "secret");
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      scripts: { build: "node build.cjs", lint: "node lint.cjs" },
    }),
  );
  await fs.symlink(
    path.join(dir, ".local"),
    path.join(dir, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await tools.execute("project_map", {}, signal);
  assert.ok(result.entries.some((e) => e.path === "src/a.js"));
  assert.ok(!result.entries.some((e) => /\.env|\.local|alias/.test(e.path)));
  assert.equal(result.scripts.build, "node build.cjs");
});
test("run_check executes detected build/lint scripts and reports actual failures", async (t) => {
  const { dir, tools, approved, signal } = await fixture(t);
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      scripts: { build: "node build.cjs", lint: "node lint.cjs" },
    }),
  );
  await fs.writeFile(path.join(dir, "build.cjs"), 'console.log("BUILD_OK")');
  await fs.writeFile(
    path.join(dir, "lint.cjs"),
    'console.log("LINT_FAILURE");process.exitCode=2',
  );
  const built = await tools.execute("run_check", { script: "build" }, signal);
  assert.equal(built.code, 0);
  assert.match(built.output, /BUILD_OK/);
  assert.equal(
    (await tools.execute("run_check", { script: "lint" }, signal)).code,
    2,
  );
  await assert.rejects(
    tools.execute("run_check", { script: "check" }, signal),
    /No check script/,
  );
  assert.ok(approved.every((name) => name === "run_check"));
});
test("oversized tool feedback remains valid JSON with explicit truncation", async (t) => {
  const { dir, signal, cleanup } = await fixture(t);
  const store = new Store(dir);
  cleanup.push(() => store.close());
  let round = 0;
  await runAgent({
    store,
    chatId: store.createChat("large").id,
    text: "read",
    model: "test",
    signal,
    emit: () => {},
    tools: {
      workspace: dir,
      execute: async () => ({ output: "x".repeat(40000) }),
    },
    ollama: {
      chat: async ({ messages }) => {
        if (!round++)
          return {
            role: "assistant",
            content: "",
            tokens: 0,
            tool_calls: [
              { function: { name: "read_file", arguments: { path: "a" } } },
            ],
          };
        const result = JSON.parse(messages.at(-1).content);
        assert.equal(result.truncated, true);
        assert.ok(result.preview.length <= 18000);
        return { role: "assistant", content: "done", tokens: 0 };
      },
    },
  });
});
