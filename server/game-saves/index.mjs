import { GameSaveManager } from "./manager.mjs";
import { resolveAdapter, listAdapters } from "./adapters/index.mjs";
import { ensureGameSaveSchema } from "./jobs.mjs";
import { sha256Buffer, sha256File } from "./hashing.mjs";
import { parseGvas, serializeGvas, isGvas, buildFixtureSave } from "./gvas.mjs";
import { discoverSteam, discoverSteamApp } from "./steam.mjs";
import { sinkingCity2Adapter } from "./adapters/sinking-city-2.mjs";

export {
  GameSaveManager,
  resolveAdapter,
  listAdapters,
  ensureGameSaveSchema,
  sha256Buffer,
  sha256File,
  parseGvas,
  serializeGvas,
  isGvas,
  buildFixtureSave,
  discoverSteam,
  discoverSteamApp,
  sinkingCity2Adapter,
};

export function createManagerFromTools(tools, { user } = {}) {
  const options = tools.gameSave || {};
  return new GameSaveManager({
    store: tools.store,
    root: tools.root || tools.workspace,
    user,
    allowFixtures: options.allowFixtures === true,
    fixtureRoot: options.fixtureRoot || null,
    liveMutations: options.liveMutations !== false,
    steamRoots: options.steamRoots || [],
    saveRoots: options.saveRoots || [],
    processes: options.processes ?? null,
    adapter: options.adapter || null,
  });
}

export const GAME_SAVE_TOOLS = [
  "game_save_inspect",
  "game_save_prepare",
  "game_save_apply",
  "game_save_restore",
  "game_save_backups",
];

export function isGameSaveTool(name) {
  return GAME_SAVE_TOOLS.includes(String(name || ""));
}

export function rejectedAbsolutePathArgs(args = {}) {
  const blocked = ["sourcePath", "savePath", "targetPath", "absolutePath", "path"];
  return blocked.filter((key) => args[key] != null && args[key] !== "");
}
