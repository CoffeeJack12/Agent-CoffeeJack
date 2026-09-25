import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { runAgent } from "../server/agent.mjs";
import { Tools, definitions } from "../server/tools.mjs";
import {
  authorize,
  toolCapability,
  applyLegacyOwnerAutoApprove,
} from "../server/permissions.mjs";
import {
  preparePlan,
  recordExecution,
  evaluateFinal,
  isGameSaveRequest,
} from "../server/planner.mjs";
import { advanceTask } from "../server/task-state.mjs";
import { GameSaveManager } from "../server/game-saves/manager.mjs";
import { getJob } from "../server/game-saves/jobs.mjs";
import { sha256Buffer, sha256File } from "../server/game-saves/hashing.mjs";
import {
  parseGvas,
  serializeGvas,
  isGvas,
  buildFixtureSave,
  walkPath,
} from "../server/game-saves/gvas.mjs";
import sinkingCity2Adapter, {
  VERIFIED_INFINITE_AMMO_REFS,
  SUPPORTED_BUILD_ID,
  STACK_STRUCT_TYPE,
} from "../server/game-saves/adapters/sinking-city-2.mjs";
import {
  FIXTURE_AMMO_REFS,
  createFixtureAdapter,
  writeFixtureSave,
} from "./helpers/game-save-fixture.mjs";
import { createUser, ROLES, resolveLocalOwner } from "../server/users.mjs";

async function tempDir(t, prefix = "jack-gs-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function ownerUser(store) {
  return resolveLocalOwner(store);
}

function managerFor(dir, store, { adapter, saveRoots, processes, user } = {}) {
  return new GameSaveManager({
    store,
    root: dir,
    user: user || ownerUser(store),
    allowFixtures: true,
    fixtureRoot: path.join(dir, "fixtures"),
    liveMutations: false,
    adapter,
    saveRoots,
    processes,
  });
}

async function preparedJob(t, options = {}) {
  const dir = await tempDir(t);
  const store = new Store(dir);
  t.after(() => store.close());
  const fixtureRoot = path.join(dir, "fixtures");
  const savePath = path.join(fixtureRoot, "SaveGames", "AUTOSAVE.sav");
  await writeFixtureSave(savePath, options.save || {});
  const adapter = createFixtureAdapter({
    savePath,
    buildId: options.buildId || SUPPORTED_BUILD_ID,
    processRunning: options.processRunning === true,
    refs: options.refs || FIXTURE_AMMO_REFS,
  });
  const mgr = managerFor(dir, store, { adapter });
  return { dir, store, mgr, savePath, adapter, fixtureRoot };
}

test("1 supported build 24867144 is inspect-compatible", async (t) => {
  const { mgr } = await preparedJob(t);
  const result = await mgr.inspect({ game: "sinking-city-2" });
  assert.equal(result.ok, true);
  assert.equal(result.buildId, SUPPORTED_BUILD_ID);
  assert.equal(result.compatibility.buildSupported, true);
  assert.equal(result.compatibility.gvas, true);
  assert.equal(result.gameplayConfirmed, false);
});

test("2 unsupported build refuses write", async (t) => {
  const { mgr } = await preparedJob(t, { buildId: "99999999" });
  const inspect = await mgr.inspect({ game: "sinking-city-2" });
  assert.equal(inspect.compatibility.buildSupported, false);
  assert.equal(inspect.ok, true);
  const prepared = await mgr.prepare({
    game: "sinking-city-2",
    editId: "infinite_ammo",
  });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.code, "unsupported_version");
  assert.equal(prepared.saveModified, false);
});

test("3 valid GVAS magic and parse", async () => {
  const save = buildFixtureSave();
  const buf = serializeGvas(save);
  assert.equal(isGvas(buf), true);
  assert.equal(buf.subarray(0, 4).toString("ascii"), "GVAS");
  const parsed = parseGvas(buf);
  assert.ok(walkPath(parsed, ["EconomyManager", "StashedStacksSaveData"]));
});

test("4 malformed and truncated saves fail closed", () => {
  assert.equal(isGvas(Buffer.from("XXXX")), false);
  assert.throws(() => parseGvas(Buffer.from("GVAS")), /truncated|not_gvas/);
  assert.throws(() => parseGvas(Buffer.from("GVAS" + "\0".repeat(8))), /truncated/);
  const err = sinkingCity2Adapter.parse
    ? (() => {
        try {
          sinkingCity2Adapter.parse(Buffer.from("NOPE"));
        } catch (e) {
          return e;
        }
      })()
    : null;
  assert.equal(err.code, "not_gvas");
});

test("5 missing EconomyManager is reported", () => {
  const save = buildFixtureSave({ includeEconomy: false });
  const parsed = parseGvas(serializeGvas(save));
  const structure = sinkingCity2Adapter.validateStructure(parsed);
  assert.equal(structure.ok, false);
  assert.equal(structure.code, "missing_economy_manager");
});

test("6 missing StashedStacksSaveData is reported", () => {
  const save = buildFixtureSave({ includeStacks: false });
  const parsed = parseGvas(serializeGvas(save));
  const structure = sinkingCity2Adapter.validateStructure(parsed);
  assert.equal(structure.ok, false);
  assert.equal(structure.code, "missing_stashed_stacks");
});

test("7 wrong stack struct type is refused", () => {
  const save = buildFixtureSave({
    stackStructType: "/Script/Other.WrongStack",
    stacks: [{ item: FIXTURE_AMMO_REFS[0], count: 1 }],
  });
  const parsed = parseGvas(serializeGvas(save));
  const structure = sinkingCity2Adapter.validateStructure(parsed);
  assert.equal(structure.ok, false);
  assert.equal(structure.code, "wrong_stack_struct_type");
});

test("8 exact five-item addition on fixture adapter", async (t) => {
  const { mgr, savePath } = await preparedJob(t);
  const prepared = await mgr.prepare({
    game: "sinking-city-2",
    editId: "infinite_ammo",
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.mutation.added.length, 5);
  assert.deepEqual(prepared.mutation.added, [...FIXTURE_AMMO_REFS]);
  const parsed = parseGvas(await fs.readFile(prepared.preparedPath));
  const stacks = walkPath(parsed, ["EconomyManager", "StashedStacksSaveData"]);
  assert.equal(stacks.children.elements.length, 5);
  const live = await fs.readFile(savePath);
  assert.equal(walkPath(parseGvas(live), ["EconomyManager", "StashedStacksSaveData"]).children.elements.length, 0);
});

test("9 already-present items stay idempotent", async (t) => {
  const { mgr, savePath } = await preparedJob(t, {
    save: {
      stacks: FIXTURE_AMMO_REFS.map((item) => ({ item, count: 1 })),
    },
  });
  const first = await mgr.prepare({ game: "sinking-city-2", editId: "infinite_ammo" });
  assert.equal(first.ok, true);
  assert.equal(first.mutation.added.length, 0);
  assert.equal(first.mutation.alreadyPresent.length, 5);
  const before = await fs.readFile(first.preparedPath);
  const second = await mgr.prepare({ game: "sinking-city-2", editId: "infinite_ammo" });
  assert.equal(second.mutation.added.length, 0);
  const after = await fs.readFile(second.preparedPath);
  const parsed = parseGvas(after);
  assert.equal(
    walkPath(parsed, ["EconomyManager", "StashedStacksSaveData"]).children.elements.length,
    5,
  );
  assert.equal((await fs.readFile(savePath)).equals(await fs.readFile(savePath)), true);
  assert.ok(before.length > 0);
});

test("10 unrelated progress and settings are preserved", async (t) => {
  const { mgr } = await preparedJob(t, {
    save: { storyFlag: "chapter-9", playTime: 777, volume: 12, currency: 42 },
  });
  const prepared = await mgr.prepare({
    game: "sinking-city-2",
    editId: "infinite_ammo",
  });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.preservation.unexpectedPaths, []);
  const parsed = parseGvas(await fs.readFile(prepared.preparedPath));
  const progress = walkPath(parsed, ["Progress"]);
  const story = progress.children.find((c) => c.name === "StoryFlag");
  const play = progress.children.find((c) => c.name === "PlayTime");
  const volume = walkPath(parsed, ["Settings"]).children.find((c) => c.name === "Volume");
  const currency = walkPath(parsed, ["EconomyManager"]).children.find((c) => c.name === "Currency");
  assert.equal(story.value, "chapter-9");
  assert.equal(play.value, 777);
  assert.equal(volume.value, 12);
  assert.equal(currency.value, 42);
});

test("11 parser round-trip preserves fixture semantics", () => {
  const original = buildFixtureSave({
    stacks: [{ item: FIXTURE_AMMO_REFS[0], count: 1 }],
    storyFlag: "round-trip",
  });
  const once = parseGvas(serializeGvas(original));
  const twice = parseGvas(serializeGvas(once));
  assert.equal(walkPath(twice, ["Progress"]).children.find((c) => c.name === "StoryFlag").value, "round-trip");
  assert.equal(
    walkPath(twice, ["EconomyManager", "StashedStacksSaveData"]).children.elements.length,
    1,
  );
});

test("12 running game blocks prepare and apply", async (t) => {
  const { mgr, store } = await preparedJob(t, { processRunning: true });
  const prepared = await mgr.prepare({
    game: "sinking-city-2",
    editId: "infinite_ammo",
  });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.requiresGameClosed, true);
  const idle = await preparedJob(t);
  const ok = await idle.mgr.prepare({ game: "sinking-city-2", editId: "infinite_ammo" });
  assert.equal(ok.ok, true);
  idle.adapter.discoverProcesses = async () => ({
    running: true,
    matches: [{ name: "TSC2.exe", executablePath: "/tmp/x/TSC2.exe" }],
  });
  idle.mgr.forcedAdapter = idle.adapter;
  const applied = await idle.mgr.apply({ jobId: ok.jobId });
  assert.equal(applied.ok, false);
  assert.equal(applied.requiresGameClosed, true);
  assert.ok(store);
});

test("13 stopped game permits fixture prepare", async (t) => {
  const { mgr } = await preparedJob(t, { processRunning: false });
  const prepared = await mgr.prepare({
    game: "sinking-city-2",
    editId: "infinite_ammo",
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.processRunning, false);
});

test("14-16 backup and hashes are recorded and unique", async (t) => {
  const { mgr, store } = await preparedJob(t);
  const prepared = await mgr.prepare({
    game: "sinking-city-2",
    editId: "infinite_ammo",
  });
  assert.ok(prepared.backupPath);
  assert.match(prepared.backupHash, /^[a-f0-9]{64}$/);
  assert.match(prepared.preparedHash, /^[a-f0-9]{64}$/);
  assert.equal(await sha256File(prepared.backupPath), prepared.sourceHash);
  assert.equal(await sha256File(prepared.preparedPath), prepared.preparedHash);
  const job = getJob(store, prepared.jobId, ownerUser(store).id);
  assert.equal(job.backup_hash, prepared.backupHash);
  assert.equal(job.prepared_hash, prepared.preparedHash);
  const again = await mgr.prepare({ game: "sinking-city-2", editId: "infinite_ammo" });
  assert.notEqual(again.backupPath, prepared.backupPath);
});

test("17-18 source change after prepare refuses apply with no partial write", async (t) => {
  const { mgr, savePath } = await preparedJob(t);
  const prepared = await mgr.prepare({
    game: "sinking-city-2",
    editId: "infinite_ammo",
  });
  const before = await fs.readFile(savePath);
  const beforeHash = sha256Buffer(before);
  await fs.writeFile(savePath, Buffer.concat([before, Buffer.from("x")]));
  const applied = await mgr.apply({ jobId: prepared.jobId });
  assert.equal(applied.ok, false);
  assert.equal(applied.code, "source_changed_since_prepare");
  const after = await fs.readFile(savePath);
  assert.equal(sha256Buffer(after) === prepared.preparedHash, false);
  assert.notEqual(sha256Buffer(after), beforeHash);
  assert.ok(after.equals(Buffer.concat([before, Buffer.from("x")])));
});

test("19-20 successful fixture apply verifies installed hash", async (t) => {
  const { mgr, savePath } = await preparedJob(t);
  const prepared = await mgr.prepare({
    game: "sinking-city-2",
    editId: "infinite_ammo",
  });
  const applied = await mgr.apply({ jobId: prepared.jobId });
  assert.equal(applied.ok, true);
  assert.equal(applied.saveModified, true);
  assert.equal(applied.installedVerified, true);
  assert.equal(applied.gameplayConfirmed, false);
  assert.equal(await sha256File(savePath), prepared.preparedHash);
});

test("21-22 restore returns original hash and creates restore-undo", async (t) => {
  const { mgr, savePath } = await preparedJob(t);
  const original = await fs.readFile(savePath);
  const originalHash = sha256Buffer(original);
  const prepared = await mgr.prepare({
    game: "sinking-city-2",
    editId: "infinite_ammo",
  });
  await mgr.apply({ jobId: prepared.jobId });
  const restored = await mgr.restore({ jobId: prepared.jobId });
  assert.equal(restored.ok, true);
  assert.equal(await sha256File(savePath), originalHash);
  assert.ok(restored.restoreUndoPath);
  assert.equal(await sha256File(restored.restoreUndoPath), prepared.preparedHash);
});

test("23 Standard is denied game-save discovery and writes", () => {
  const user = { id: "s", role: "standard", status: "active" };
  assert.equal(authorize({ user, capability: "game_save_inspect" }).decision, "deny");
  assert.equal(authorize({ user, capability: "game_save_prepare" }).decision, "deny");
  assert.equal(authorize({ user, capability: "game_save_write" }).decision, "deny");
});

test("24 Guest is denied", () => {
  const user = { id: "g", role: "guest", status: "active" };
  assert.equal(authorize({ user, capability: "game_save_inspect" }).decision, "deny");
  assert.equal(authorize({ user, capability: "game_save_write" }).decision, "deny");
});

test("25 Owner apply requires approval", () => {
  const user = { id: "o", role: "owner", status: "active" };
  assert.equal(authorize({ user, capability: "game_save_inspect" }).decision, "allow");
  assert.equal(authorize({ user, capability: "game_save_prepare" }).decision, "allow");
  assert.equal(authorize({ user, capability: "game_save_write" }).decision, "require_approval");
  assert.equal(toolCapability("game_save_apply"), "game_save_write");
});

test("26 legacy autoApprove does not bypass game-save write approval", () => {
  const user = { id: "o", role: "owner", status: "active" };
  const decision = authorize({ user, capability: "game_save_write" });
  const bypassed = applyLegacyOwnerAutoApprove(decision, user, true, {
    capability: "game_save_write",
  });
  assert.equal(bypassed.decision, "require_approval");
  const other = applyLegacyOwnerAutoApprove(
    authorize({ user, capability: "git_push" }),
    user,
    true,
    { capability: "git_push" },
  );
  assert.equal(other.decision, "allow");
});

test("27-28 jobs are isolated by user and restore cannot cross users", async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir);
  t.after(() => store.close());
  const owner = resolveLocalOwner(store);
  const other = createUser(store, { displayName: "Other", role: ROLES.TRUSTED });
  const fixtureRoot = path.join(dir, "fixtures");
  const savePath = path.join(fixtureRoot, "SaveGames", "AUTOSAVE.sav");
  await writeFixtureSave(savePath);
  const ownerMgr = managerFor(dir, store, {
    adapter: createFixtureAdapter({ savePath }),
    user: owner,
  });
  const prepared = await ownerMgr.prepare({
    game: "sinking-city-2",
    editId: "infinite_ammo",
  });
  const otherMgr = managerFor(dir, store, {
    adapter: createFixtureAdapter({ savePath }),
    user: other,
  });
  const stolen = await otherMgr.restore({ jobId: prepared.jobId });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.code, "job_not_found");
  assert.equal(getJob(store, prepared.jobId, other.id), null);
  assert.ok(getJob(store, prepared.jobId, owner.id));
});

test("29 chat request routes through game-save tools not terminal", async (t) => {
  const dir = await tempDir(t, "jack-gs-chat-");
  const store = new Store(dir);
  t.after(() => store.close());
  const chatId = store.createChat("ammo").id;
  const names = [];
  let output = "";
  await runAgent({
    store,
    chatId,
    text: "give me infinite ammo in my installed game",
    model: "test",
    capabilities: ["tools"],
    signal: new AbortController().signal,
    emit: (e) => {
      if (e.type === "token") output += e.text;
      if (e.type === "revise") output = e.text || "";
      if (e.type === "tool") names.push(`${e.name}:${e.status}`);
    },
    tools: {
      workspace: dir,
      execute: async (name) => {
        assert.notEqual(name, "terminal");
        assert.notEqual(name, "write_file");
        assert.notEqual(name, "apply_patch");
        if (name === "game_save_inspect")
          return {
            ok: true,
            game: "sinking-city-2",
            buildId: SUPPORTED_BUILD_ID,
            processRunning: false,
            gameplayConfirmed: false,
            compatibility: { status: "inspect_only", reasons: ["exact_verified_asset_references_missing"] },
          };
        return { ok: true, gameplayConfirmed: false };
      },
    },
    ollama: {
      chat: async ({ messages }) => {
        const system = messages[0].content;
        assert.match(system, /game_save_inspect/);
        if (!names.length)
          return {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "game_save_inspect",
                  arguments: { game: "sinking-city-2" },
                },
              },
            ],
          };
        return {
          role: "assistant",
          content:
            "Inspected The Sinking City 2. The save was not modified. Gameplay is unconfirmed.",
        };
      },
    },
  });
  assert.ok(names.some((n) => n.startsWith("game_save_inspect:")));
  assert.ok(!names.some((n) => n.startsWith("terminal:")));
  assert.equal(isGameSaveRequest("give me infinite ammo in my installed game"), true);
  const state = store.taskState(chatId);
  assert.ok(state.plan.some((s) => s.kind === "inspect"));
});

test("30 final response does not claim gameplay confirmation", () => {
  const state = advanceTask(null, "give me infinite ammo in my installed game");
  preparePlan(state, "give me infinite ammo in my installed game");
  recordExecution(state, "game_save_inspect", { success: true });
  recordExecution(state, "game_save_prepare", { success: true });
  recordExecution(state, "game_save_apply", { success: true });
  assert.equal(
    evaluateFinal(
      state,
      "The save was modified and verified on disk. Gameplay behavior is still unconfirmed.",
    ).ok,
    true,
  );
  assert.equal(
    evaluateFinal(state, "Confirmed working in gameplay.").ok,
    false,
  );
});

test("production SC2 adapter stays fail-closed without verified refs", () => {
  assert.equal(VERIFIED_INFINITE_AMMO_REFS.length, 0);
  const parsed = buildFixtureSave();
  const mutation = sinkingCity2Adapter.prepareMutation(parsed, "infinite_ammo");
  assert.equal(mutation.ok, false);
  assert.equal(mutation.code, "exact_verified_asset_references_missing");
  const compat = sinkingCity2Adapter.compatibility(parsed, SUPPORTED_BUILD_ID);
  assert.equal(compat.writable, false);
  assert.ok(compat.reasons.includes("exact_verified_asset_references_missing"));
  assert.equal(compat.stackStructType, STACK_STRUCT_TYPE);
});

test("game-save edit invalidates downstream verification evidence", () => {
  const state = advanceTask(null, "fix tests and give infinite ammo");
  preparePlan(state, "fix a bug");
  recordExecution(state, "run_tests", { success: true, code: 0 });
  assert.equal(state.plan.find((s) => s.kind === "test")?.status, "completed");
  recordExecution(state, "game_save_prepare", { success: true });
  assert.equal(state.plan.find((s) => s.kind === "test")?.status, "pending");
});

test("Tools reject model-supplied absolute save paths", async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir);
  t.after(() => store.close());
  const tools = new Tools({
    root: dir,
    workspace: dir,
    store,
    approve: async () => {},
    gameSave: { allowFixtures: true, fixtureRoot: dir, liveMutations: false },
  });
  await assert.rejects(
    tools.execute(
      "game_save_inspect",
      { sourcePath: "C:\\\\Users\\\\Abdul\\\\AppData\\\\Local\\\\TSC2\\\\x.sav" },
      new AbortController().signal,
    ),
    /do not accept caller-provided absolute save paths/i,
  );
});

test("definitions include dedicated game-save tools", () => {
  const names = definitions.map((d) => d.function.name);
  for (const name of [
    "game_save_inspect",
    "game_save_prepare",
    "game_save_apply",
    "game_save_restore",
    "game_save_backups",
  ])
    assert.ok(names.includes(name), name);
});

test("Trusted cannot prepare or apply live game-save writes", () => {
  const user = { id: "t", role: "trusted", status: "active" };
  assert.equal(authorize({ user, capability: "game_save_inspect" }).decision, "allow");
  assert.equal(authorize({ user, capability: "game_save_prepare" }).decision, "deny");
  assert.equal(authorize({ user, capability: "game_save_write" }).decision, "deny");
});

test("jobs survive store reopen", async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir);
  const fixtureRoot = path.join(dir, "fixtures");
  const savePath = path.join(fixtureRoot, "SaveGames", "AUTOSAVE.sav");
  await writeFixtureSave(savePath);
  const mgr = managerFor(dir, store, {
    adapter: createFixtureAdapter({ savePath }),
  });
  const prepared = await mgr.prepare({
    game: "sinking-city-2",
    editId: "infinite_ammo",
  });
  store.close();
  const store2 = new Store(dir);
  t.after(() => store2.close());
  const job = getJob(store2, prepared.jobId, resolveLocalOwner(store2).id);
  assert.equal(job.prepared_hash, prepared.preparedHash);
});
