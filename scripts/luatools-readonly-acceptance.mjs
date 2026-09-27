/**
 * Read-only LuaTools acceptance.
 * Verifies installation/state discovery without changing LuaTools or Steam files.
 */
import {
  luaToolsStatus,
  listLuaToolsManaged,
  inspectLuaToolsGame,
} from "../server/luatools.mjs";

const before = await listLuaToolsManaged();
const status = await luaToolsStatus();
const sinking = await inspectLuaToolsGame("2825860");
const after = await listLuaToolsManaged();

const beforeHashes = Object.fromEntries(
  before.entries.map((entry) => [entry.appId, entry.sha256]),
);
const afterHashes = Object.fromEntries(
  after.entries.map((entry) => [entry.appId, entry.sha256]),
);
const hashesUnchanged =
  JSON.stringify(beforeHashes) === JSON.stringify(afterHashes);

const vaultHash = sinking.vault.variants[0]?.hash || null;
const report = {
  ok:
    status.installed === true &&
    status.steamDetected === true &&
    before.count === after.count &&
    hashesUnchanged &&
    sinking.active === true,
  readOnly: true,
  installed: status.installed,
  version: status.version,
  running: status.running,
  selectedMode: status.settings.selectedMode,
  pluginVersion: status.plugin.version,
  activeLuaCount: status.activeLuaCount,
  managedCount: before.count,
  sinkingCity2: {
    active: sinking.active,
    luaSha256: sinking.activeLuaSha256,
    vaultHash,
    matchesVault: Boolean(vaultHash && vaultHash === sinking.activeLuaSha256),
  },
  hashesUnchanged,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok || report.sinkingCity2.matchesVault !== true) process.exitCode = 1;
