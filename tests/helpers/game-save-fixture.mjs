import fs from "node:fs/promises";
import path from "node:path";
import sinkingCity2Adapter, {
  applyStashedStackEdit,
  STACK_STRUCT_TYPE,
  SUPPORTED_BUILD_ID,
  STEAM_APP_ID,
} from "../../server/game-saves/adapters/sinking-city-2.mjs";
import { buildFixtureSave, serializeGvas } from "../../server/game-saves/gvas.mjs";

/** Synthetic refs for fixture-only mutation tests. Not production TSC2 paths. */
export const FIXTURE_AMMO_REFS = Object.freeze([
  "/Game/CoffeeJackFixture/Items/HandgunSupplyBox.HandgunSupplyBox_C",
  "/Game/CoffeeJackFixture/Items/ShotgunSupplyBox.ShotgunSupplyBox_C",
  "/Game/CoffeeJackFixture/Items/SmgSupplyBox.SmgSupplyBox_C",
  "/Game/CoffeeJackFixture/Items/RifleSupplyBox.RifleSupplyBox_C",
  "/Game/CoffeeJackFixture/Items/ExplosiveSupplyBox.ExplosiveSupplyBox_C",
]);

export async function writeFixtureSave(filePath, options = {}) {
  const save = buildFixtureSave(options);
  const buffer = serializeGvas(save);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
  return { save, buffer, path: filePath };
}

export function createFixtureAdapter({
  savePath,
  buildId = SUPPORTED_BUILD_ID,
  refs = FIXTURE_AMMO_REFS,
  processRunning = false,
  installDir = path.join(path.sep, "tmp", "coffeejack-fake-tsc2"),
} = {}) {
  return {
    ...sinkingCity2Adapter,
    id: sinkingCity2Adapter.id,
    async discoverInstall() {
      return {
        found: true,
        appId: STEAM_APP_ID,
        name: "The Sinking City 2",
        buildId,
        installDir,
      };
    },
    discoverBuild() {
      return buildId;
    },
    async discoverProcesses() {
      return {
        running: processRunning,
        matches: processRunning
          ? [{ name: "TSC2-Win64-Shipping.exe", executablePath: path.join(installDir, "Binaries", "TSC2.exe") }]
          : [],
      };
    },
    async discoverSaves() {
      const stat = await fs.stat(savePath);
      const selected = {
        path: savePath,
        name: path.basename(savePath),
        mtimeMs: stat.mtimeMs,
        dir: path.dirname(savePath),
      };
      return {
        selected,
        reason: "latest_autosave",
        candidates: [selected],
        files: [selected],
        roots: [path.dirname(savePath)],
      };
    },
    compatibility(parsed, id) {
      const base = sinkingCity2Adapter.compatibility(parsed, id);
      const refsReady = refs.length === 5;
      const writable =
        Boolean(parsed) &&
        base.buildSupported &&
        base.gvas &&
        base.economyManager &&
        base.stashedStacks &&
        refsReady &&
        !base.reasons.includes("wrong_stack_struct_type");
      const reasons = base.reasons.filter(
        (r) => r !== "exact_verified_asset_references_missing",
      );
      if (!refsReady) reasons.push("exact_verified_asset_references_missing");
      return {
        ...base,
        writable,
        reasons,
        verifiedRefs: refs.length,
        status: writable ? "supported" : "inspect_only",
      };
    },
    prepareMutation(parsed, editId) {
      if (editId !== "infinite_ammo")
        return { ok: false, code: "unsupported_edit", message: editId };
      if (refs.length !== 5)
        return {
          ok: false,
          code: "exact_verified_asset_references_missing",
          message: "Fixture adapter missing five test refs",
        };
      const structure = sinkingCity2Adapter.validateStructure(parsed);
      if (!structure.ok) return structure;
      const mutation = applyStashedStackEdit(parsed, refs, {
        structType: STACK_STRUCT_TYPE,
      });
      return { ok: true, editId, refs: [...refs], ...mutation };
    },
    activationInstructions(editId, mutation = {}) {
      return sinkingCity2Adapter.activationInstructions(editId, {
        added: mutation.added || refs,
      });
    },
  };
}
