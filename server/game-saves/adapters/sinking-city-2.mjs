import fs from "node:fs/promises";
import path from "node:path";
import { discoverSteamApp } from "../steam.mjs";
import { inspectInstallProcess } from "../processes.mjs";
import {
  parseGvas,
  serializeGvas,
  isGvas,
  walkPath,
  semanticSnapshot,
  diffSnapshots,
  makeSoftClass,
  makeInt,
  makeNone,
} from "../gvas.mjs";

export const GAME_ID = "sinking-city-2";
export const STEAM_APP_ID = "2825860";
export const SUPPORTED_BUILD_ID = "24867144";
export const STACK_STRUCT_TYPE = "/Script/Economy.InventoryItemStack";
export const ECONOMY_PATH = ["EconomyManager"];
export const STASHED_STACKS_PATH = ["EconomyManager", "StashedStacksSaveData"];

/**
 * Verified infinite-ammo SoftClass paths for Steam build 24867144.
 * These must come from a previously successful local edit. Searches of this
 * repository, available transcripts, and local artifacts recovered none.
 * Write/apply stays fail-closed until this list contains exactly five verified
 * Unreal paths. Do not invent similar-looking references.
 */
export const VERIFIED_INFINITE_AMMO_REFS = Object.freeze([]);

export const ALIASES = Object.freeze([
  "sinking-city-2",
  "sinking city 2",
  "the sinking city 2",
  "tsc2",
  "tsc 2",
]);

const AUTOSAVE_RE = /autosave/i;

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function itemRefOf(stack) {
  if (!stack) return null;
  for (const child of stack.children || []) {
    if (child.terminator) continue;
    if (
      ["SoftClassProperty", "SoftObjectProperty", "StrProperty", "NameProperty", "ObjectProperty"].includes(
        child.type,
      )
    )
      return { field: child.name, value: String(child.value ?? "") };
  }
  return null;
}

export function stackMatchesRef(stack, ref) {
  const found = itemRefOf(stack);
  return Boolean(found && found.value === ref);
}

export function applyStashedStackEdit(save, refs, { count = 1, structType = STACK_STRUCT_TYPE } = {}) {
  const economy = walkPath(save, ECONOMY_PATH);
  if (!economy) {
    const err = new Error("missing_economy_manager");
    err.code = "missing_economy_manager";
    throw err;
  }
  const stacks = walkPath(save, STASHED_STACKS_PATH);
  if (!stacks) {
    const err = new Error("missing_stashed_stacks");
    err.code = "missing_stashed_stacks";
    throw err;
  }
  const dummyType = stacks.children?.dummy?.structType;
  const firstType = stacks.children?.elements?.[0]?.extra?.structType;
  const actualType = dummyType || firstType || structType;
  if (actualType && actualType !== structType) {
    const err = new Error("wrong_stack_struct_type");
    err.code = "wrong_stack_struct_type";
    err.details = { actualType, expectedType: structType };
    throw err;
  }
  const elements = stacks.children?.elements || [];
  const existingRefs = new Set(
    elements.map((el) => itemRefOf(el)?.value).filter(Boolean),
  );
  const field =
    itemRefOf(elements[0])?.field ||
    "Item";
  const added = [];
  for (const ref of refs) {
    if (existingRefs.has(ref)) continue;
    elements.push({
      type: "StructProperty",
      extra: { structType },
      dirty: true,
      children: [makeSoftClass(field, ref), makeInt("Count", count), makeNone()],
    });
    existingRefs.add(ref);
    added.push(ref);
  }
  stacks.dirty = true;
  stacks.children = {
    ...(stacks.children || { format: "ue4-struct-array" }),
    elements,
    dummy: {
      ...(stacks.children?.dummy || {}),
      name: stacks.name,
      structType,
    },
  };
  const parent = walkPath(save, ECONOMY_PATH);
  if (parent) parent.dirty = true;
  return {
    added,
    alreadyPresent: refs.filter((ref) => !added.includes(ref)),
    total: elements.length,
  };
}

async function walkFiles(root, { max = 400 } = {}) {
  const found = [];
  const stack = [root];
  while (stack.length && found.length < max) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) found.push(full);
    }
  }
  return found;
}

function defaultSaveRoots() {
  const roots = [];
  if (process.env.LOCALAPPDATA)
    roots.push(path.join(process.env.LOCALAPPDATA, "TSC2"));
  if (process.platform === "win32" && process.env.USERPROFILE)
    roots.push(path.join(process.env.USERPROFILE, "AppData", "Local", "TSC2"));
  return roots;
}

export function identifyAutosave(candidates) {
  const autosaves = candidates.filter((c) => AUTOSAVE_RE.test(c.name || c.path));
  if (!autosaves.length) {
    return {
      selected: null,
      reason: "no_autosave",
      candidates,
    };
  }
  const ranked = [...autosaves].sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return String(a.name).localeCompare(String(b.name));
  });
  const latest = ranked[0];
  const tied = ranked.filter((c) => c.mtimeMs === latest.mtimeMs);
  if (tied.length > 1) {
    return {
      selected: null,
      reason: "ambiguous_autosave",
      candidates: tied,
    };
  }
  return { selected: latest, reason: "latest_autosave", candidates: autosaves };
}

export const sinkingCity2Adapter = {
  id: GAME_ID,
  aliases: ALIASES,
  distribution: { type: "steam", appId: STEAM_APP_ID },
  supportedBuilds: Object.freeze([SUPPORTED_BUILD_ID]),
  edits: Object.freeze([
    {
      id: "infinite_ammo",
      title: "Infinite ammo supply boxes",
      requiresVerifiedRefs: true,
    },
  ]),

  matches(game) {
    const key = String(game || "").trim().toLowerCase();
    if (!key) return true;
    return ALIASES.some((alias) => alias === key || key.includes(alias));
  },

  async discoverInstall(ctx = {}) {
    return discoverSteamApp(STEAM_APP_ID, {
      signal: ctx.signal,
      extraRoots: ctx.steamRoots || [],
    });
  },

  discoverBuild(install) {
    return install?.buildId || null;
  },

  async discoverProcesses(install, ctx = {}) {
    return inspectInstallProcess(install?.installDir, {
      signal: ctx.signal,
      injected: ctx.processes,
    });
  },

  async discoverSaves(ctx = {}) {
    const roots = [...(ctx.saveRoots || []), ...defaultSaveRoots()];
    const files = [];
    const seen = new Set();
    for (const root of roots) {
      let real;
      try {
        real = await fs.realpath(root);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      for (const file of await walkFiles(real)) {
        const stat = await fs.stat(file);
        files.push({
          path: file,
          name: path.basename(file),
          dir: path.dirname(file),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          root: real,
        });
      }
    }
    const saveGames = files.filter((f) =>
      /savegames/i.test(f.dir.split(path.sep).join("/")),
    );
    const pool = saveGames.length ? saveGames : files;
    const identified = identifyAutosave(pool);
    return {
      roots: [...seen],
      files: pool,
      ...identified,
    };
  },

  parse(buffer) {
    if (!isGvas(buffer)) {
      const err = new Error("not_gvas");
      err.code = "not_gvas";
      throw err;
    }
    return parseGvas(buffer);
  },

  serialize(save) {
    return serializeGvas(save);
  },

  compatibility(parsed, buildId) {
    const reasons = [];
    const magicOk = Boolean(parsed?.header);
    if (!magicOk) reasons.push("not_gvas");
    const build = String(buildId || "");
    const buildSupported = build === SUPPORTED_BUILD_ID;
    if (!buildSupported) reasons.push("unsupported_version");
    const economy = parsed ? walkPath(parsed, ECONOMY_PATH) : null;
    const stacks = parsed ? walkPath(parsed, STASHED_STACKS_PATH) : null;
    if (parsed && !economy) reasons.push("missing_economy_manager");
    if (parsed && !stacks) reasons.push("missing_stashed_stacks");
    const refsReady = VERIFIED_INFINITE_AMMO_REFS.length === 5;
    if (!refsReady) reasons.push("exact_verified_asset_references_missing");
    const writable = magicOk && buildSupported && economy && stacks && refsReady;
    return {
      status: writable ? "supported" : "inspect_only",
      writable: Boolean(writable),
      inspectAllowed: magicOk,
      buildId: build || null,
      supportedBuildId: SUPPORTED_BUILD_ID,
      buildSupported,
      gvas: magicOk,
      economyManager: Boolean(economy),
      stashedStacks: Boolean(stacks),
      stackStructType: stacks?.children?.dummy?.structType || STACK_STRUCT_TYPE,
      verifiedRefs: VERIFIED_INFINITE_AMMO_REFS.length,
      reasons,
    };
  },

  validateStructure(parsed) {
    if (!parsed?.header) return fail("not_gvas", "Save is not a GVAS document");
    if (!walkPath(parsed, ECONOMY_PATH))
      return fail("missing_economy_manager", "EconomyManager was not found");
    const stacks = walkPath(parsed, STASHED_STACKS_PATH);
    if (!stacks)
      return fail("missing_stashed_stacks", "StashedStacksSaveData was not found");
    const structType =
      stacks.children?.dummy?.structType ||
      stacks.children?.elements?.[0]?.extra?.structType;
    if (structType && structType !== STACK_STRUCT_TYPE)
      return fail(
        "wrong_stack_struct_type",
        `Expected ${STACK_STRUCT_TYPE}`,
        { actualType: structType },
      );
    return { ok: true };
  },

  validatePreservation(before, after, { allowedPrefixes = ["EconomyManager.StashedStacksSaveData"] } = {}) {
    const beforeSnap = semanticSnapshot(before, [STASHED_STACKS_PATH, ECONOMY_PATH]);
    const afterSnap = semanticSnapshot(after, [STASHED_STACKS_PATH, ECONOMY_PATH]);
    const changes = diffSnapshots(beforeSnap, afterSnap);
    const unexpected = changes.filter(
      (change) =>
        !allowedPrefixes.some(
          (prefix) =>
            change.path === prefix ||
            change.path.startsWith(`${prefix}.`) ||
            change.path.includes("StashedStacksSaveData"),
        ),
    );
    return {
      ok: unexpected.length === 0,
      changes,
      unexpected,
      summary: {
        changedPaths: changes.map((c) => c.path).slice(0, 20),
        unexpectedPaths: unexpected.map((c) => c.path).slice(0, 20),
        changeCount: changes.length,
      },
    };
  },

  prepareMutation(parsed, editId) {
    if (editId !== "infinite_ammo") {
      return fail("unsupported_edit", `Unsupported edit: ${editId}`);
    }
    if (VERIFIED_INFINITE_AMMO_REFS.length !== 5) {
      return fail(
        "exact_verified_asset_references_missing",
        "The five verified Sinking City 2 ammo-box asset references were not recovered. Write/apply is refuse-closed.",
        { verifiedRefs: [] },
      );
    }
    const structure = this.validateStructure(parsed);
    if (!structure.ok) return structure;
    const mutation = applyStashedStackEdit(parsed, VERIFIED_INFINITE_AMMO_REFS);
    return {
      ok: true,
      editId,
      refs: [...VERIFIED_INFINITE_AMMO_REFS],
      ...mutation,
    };
  },

  activationInstructions(editId, mutation = {}) {
    if (editId !== "infinite_ammo") return null;
    const inserted = mutation.added || VERIFIED_INFINITE_AMMO_REFS;
    return {
      editId,
      carryInInventory: true,
      inserted,
      text:
        "The relevant infinite-ammo boxes must be carried in the player's inventory for their effects to apply. " +
        (inserted.length
          ? `Inserted supply entries: ${inserted.join(", ")}.`
          : "No verified supply entries are available to insert.") +
        " Do not assume the game recognized them until gameplay is actually tested.",
    };
  },
};

export default sinkingCity2Adapter;
