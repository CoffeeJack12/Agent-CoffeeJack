import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  luaToolsStatus,
  listLuaToolsManaged,
  inspectLuaToolsGame,
} from "../server/luatools.mjs";
import { Tools, definitions } from "../server/tools.mjs";
import { authorize, toolCapability } from "../server/permissions.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jack-luatools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, "local", "LuaTools");
  const currentRoot = path.join(installRoot, "current");
  const dataRoot = path.join(root, "roaming", "LuaToolsGui");
  const steamRoot = path.join(root, "Steam");
  await fs.mkdir(currentRoot, { recursive: true });
  await fs.mkdir(path.join(dataRoot, "plugin"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "details"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "luavault", "2825860"), { recursive: true });
  await fs.mkdir(path.join(steamRoot, "config", "stplug-in"), { recursive: true });
  await fs.mkdir(path.join(steamRoot, "config", "lua"), { recursive: true });
  await fs.mkdir(path.join(steamRoot, "steamapps"), { recursive: true });

  await fs.writeFile(path.join(currentRoot, "LuaTools.exe"), "fixture");
  await fs.writeFile(
    path.join(currentRoot, "sq.version"),
    "<package><metadata><version>1.3.2</version></metadata></package>",
  );
  await fs.writeFile(path.join(dataRoot, "auth.dat"), "DO-NOT-READ");
  await fs.writeFile(
    path.join(dataRoot, "settings.json"),
    JSON.stringify({
      SelectedMode: "Bst",
      FastFetch: true,
      DonateKeys: false,
      HubcapApiKey: "SUPER_SECRET_KEY",
    }),
  );
  await fs.writeFile(
    path.join(dataRoot, "plugin", "installed.json"),
    JSON.stringify({ Tag: "v2.2", DllSha: "abc123" }),
  );
  await fs.writeFile(
    path.join(dataRoot, "details", "2825860.json"),
    JSON.stringify({ name: "The Sinking City 2", steam_appid: 2825860 }),
  );
  await fs.writeFile(
    path.join(dataRoot, "luavault", "2825860", "index.json"),
    JSON.stringify({
      AppId: 2825860,
      Variants: [
        {
          Hash: "hash1",
          Kind: "default",
          CapturedAt: "2026-09-17T23:31:50Z",
          DepotCount: 4,
          DlcCount: 3,
        },
      ],
    }),
  );
  const lua = "fixture lua contents";
  await fs.writeFile(path.join(steamRoot, "config", "stplug-in", "2825860.lua"), lua);
  await fs.writeFile(path.join(steamRoot, "config", "lua", "2825860.lua"), lua);
  await fs.writeFile(path.join(steamRoot, "steam.exe"), "fixture");
  await fs.writeFile(
    path.join(steamRoot, "steamapps", "appmanifest_2825860.acf"),
    '"AppState" { "appid" "2825860" "name" "The Sinking City 2" }',
  );
  return {
    root,
    installRoot,
    dataRoot,
    steamRoot,
    running: false,
    expectedHash: crypto.createHash("sha256").update(lua).digest("hex"),
  };
}
test("LuaTools status exposes safe state without leaking stored API keys", async (t) => {
  const f = await fixture(t);
  const status = await luaToolsStatus(f);
  assert.equal(status.ok, true);
  assert.equal(status.installed, true);
  assert.equal(status.version, "1.3.2");
  assert.equal(status.running, false);
  assert.equal(status.loggedIn, true);
  assert.equal(status.steamDetected, true);
  assert.equal(status.activeLuaCount, 1);
  assert.equal(status.settings.selectedMode, "Bst");
  assert.equal(status.settings.fastFetch, true);
  assert.equal(status.settings.hubcapConfigured, true);
  assert.equal(status.plugin.version, "v2.2");
  assert.equal(JSON.stringify(status).includes("SUPER_SECRET_KEY"), false);
  assert.equal(JSON.stringify(status).includes("DO-NOT-READ"), false);
});

test("LuaTools managed list and game inspection verify on-disk state", async (t) => {
  const f = await fixture(t);
  const managed = await listLuaToolsManaged(f);
  assert.equal(managed.count, 1);
  assert.equal(managed.entries[0].appId, "2825860");
  assert.equal(managed.entries[0].name, "The Sinking City 2");
  assert.equal(managed.entries[0].sha256, f.expectedHash);
  assert.equal(managed.entries[0].vaultVariants, 1);

  const game = await inspectLuaToolsGame("2825860", f);
  assert.equal(game.active, true);
  assert.equal(game.activeLuaSha256, f.expectedHash);
  assert.equal(game.legacyLuaPresent, true);
  assert.equal(game.steamManifestPresent, true);
  assert.equal(game.vault.variants[0].depotCount, 4);
  assert.equal(game.vault.variants[0].dlcCount, 3);
});
test("LuaTools permissions separate inspection from GUI control", () => {
  const owner = { id: "o", role: "owner", status: "active" };
  const trusted = { id: "t", role: "trusted", status: "active" };
  const standard = { id: "s", role: "standard", status: "active", email_verified: true };

  assert.equal(toolCapability("luatools", { action: "status" }), "luatools_inspect");
  assert.equal(toolCapability("luatools", { action: "inspect_game" }), "luatools_inspect");
  assert.equal(toolCapability("luatools", { action: "open" }), "luatools_control");
  assert.equal(toolCapability("luatools", { action: "navigate" }), "luatools_control");

  assert.equal(authorize({ user: owner, capability: "luatools_inspect" }).decision, "allow");
  assert.equal(authorize({ user: owner, capability: "luatools_control" }).decision, "require_approval");
  assert.equal(authorize({ user: trusted, capability: "luatools_inspect" }).decision, "allow");
  assert.equal(authorize({ user: trusted, capability: "luatools_control" }).decision, "deny");
  assert.equal(authorize({ user: standard, capability: "luatools_inspect" }).decision, "deny");
});

test("LuaTools tool definition is present and read-only status skips approval", async (t) => {
  const f = await fixture(t);
  assert.ok(definitions.some((d) => d.function.name === "luatools"));
  let approvals = 0;
  const tools = new Tools({
    root: f.root,
    workspace: f.root,
    approve: async () => {
      approvals += 1;
    },
    luaTools: f,
  });
  const result = await tools.execute(
    "luatools",
    { action: "status" },
    new AbortController().signal,
  );
  assert.equal(result.version, "1.3.2");
  assert.equal(approvals, 0);
});
