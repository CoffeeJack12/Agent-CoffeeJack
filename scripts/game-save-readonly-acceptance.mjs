/**
 * Read-only local acceptance for The Sinking City 2.
 * Never prepare/apply/restore against a live save.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSteamApp } from "../server/game-saves/steam.mjs";
import { inspectInstallProcess } from "../server/game-saves/processes.mjs";
import sinkingCity2Adapter, {
  STEAM_APP_ID,
  SUPPORTED_BUILD_ID,
} from "../server/game-saves/adapters/sinking-city-2.mjs";
import { sha256Buffer, isGvas } from "../server/game-saves/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function redact(p) {
  if (!p) return null;
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? parts.join("/") : `…/${parts.slice(-2).join("/")}`;
}

const report = {
  liveSaveModified: false,
  prepareAttempted: false,
  applyAttempted: false,
  restoreAttempted: false,
  gameplayConfirmed: false,
};

try {
  const install = await discoverSteamApp(STEAM_APP_ID);
  report.steamAppId = STEAM_APP_ID;
  report.installFound = Boolean(install.found);
  report.installDir = redact(install.installDir);
  report.buildId = install.buildId || null;
  report.supportedBuild = install.buildId === SUPPORTED_BUILD_ID;
  const processInfo = await inspectInstallProcess(install.installDir);
  report.processRunning = processInfo.running;
  report.processMatches = (processInfo.matches || []).map((m) => m.name);
  const saves = await sinkingCity2Adapter.discoverSaves();
  report.saveRoots = (saves.roots || []).map(redact);
  report.autosaveReason = saves.reason;
  report.selectedSave = saves.selected ? redact(saves.selected.path) : null;
  report.candidateCount = (saves.candidates || []).length;

  if (saves.selected?.path) {
    const live = await fs.readFile(saves.selected.path);
    report.liveHash = sha256Buffer(live);
    report.gvasMagic = isGvas(live);
    const destDir = path.join(root, ".local", "game-save-fixtures", "readonly-acceptance");
    await fs.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, "copied-autosave.sav");
    await fs.writeFile(dest, live, { flag: "w" });
    report.copiedFixture = true;
    report.copiedHash = sha256Buffer(await fs.readFile(dest));
    report.liveUnchanged = report.copiedHash === report.liveHash;
    try {
      const parsed = sinkingCity2Adapter.parse(await fs.readFile(dest));
      report.parseOk = true;
      report.compatibility = sinkingCity2Adapter.compatibility(parsed, install.buildId);
    } catch (error) {
      report.parseOk = false;
      report.parseError = error.code || error.message;
      report.compatibility = sinkingCity2Adapter.compatibility(null, install.buildId);
    }
  } else {
    report.copiedFixture = false;
    report.compatibility = sinkingCity2Adapter.compatibility(null, install.buildId);
  }
} catch (error) {
  report.error = error.message;
}

report.verifiedRefsRecovered = false;
report.writeAllowed =
  report.supportedBuild === true &&
  report.compatibility?.writable === true;
console.log(JSON.stringify(report, null, 2));
