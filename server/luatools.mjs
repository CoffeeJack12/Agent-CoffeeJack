import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

function localAppData() {
  return process.env.LOCALAPPDATA || (
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Local")
      : null
  );
}

function roamingAppData() {
  return process.env.APPDATA || (
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Roaming")
      : null
  );
}

function luaToolsGuiRoot() {
  const roaming = roamingAppData();
  return roaming ? path.join(roaming, "LuaToolsGui") : null;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function sha256File(file) {
  const data = await fs.readFile(file);
  return createHash("sha256").update(data).digest("hex");
}

export function luaToolsPaths() {
  if (process.platform !== "win32") return { root: null, exe: null };
  const local = localAppData();
  const root = local ? path.join(local, "LuaTools") : null;
  const candidates = root
    ? [
        path.join(root, "current", "LuaTools.exe"),
        path.join(root, "LuaTools.exe"),
      ]
    : [];
  return {
    root,
    exe: candidates.find((candidate) => existsSync(candidate)) || null,
  };
}

function steamRoot() {
  if (process.platform !== "win32") return null;
  const candidates = [
    process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"], "Steam")
      : null,
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, "Steam")
      : null,
    "C:\\Program Files (x86)\\Steam",
    "C:\\Program Files\\Steam",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(path.join(candidate, "steam.exe"))) || null;
}
async function readVersion(root) {
  if (!root) return null;
  const file = path.join(root, "current", "sq.version");
  try {
    const xml = await fs.readFile(file, "utf8");
    return xml.match(/<version>([^<]+)<\/version>/i)?.[1] || null;
  } catch {
    return null;
  }
}

async function readAppManifest(root, appId) {
  if (!root || !appId) return null;
  const file = path.join(root, "steamapps", `appmanifest_${appId}.acf`);
  try {
    const text = await fs.readFile(file, "utf8");
    const depotBlock =
      text.match(/"InstalledDepots"\s*\{([\s\S]*?)"SharedDepots"/i)?.[1] || "";
    const installedDepots = [...depotBlock.matchAll(
      /"(\d+)"\s*\{\s*"manifest"\s*"([^"]+)"(?:\s*"size"\s*"([^"]+)")?/gi,
    )].map((match) => ({
      depot_id: Number(match[1]),
      manifest_id: match[2],
      size: match[3] ? Number(match[3]) : null,
    }));
    return {
      path: file,
      name: text.match(/"name"\s+"([^"]+)"/i)?.[1] || null,
      installdir: text.match(/"installdir"\s+"([^"]+)"/i)?.[1] || null,
      buildid: text.match(/"buildid"\s+"([^"]+)"/i)?.[1] || null,
      installed_depots: installedDepots,
    };
  } catch {
    return null;
  }
}

async function luaEntries(root) {
  if (!root) return [];
  const dirs = [
    { kind: "stplug-in", dir: path.join(root, "config", "stplug-in") },
    { kind: "lua", dir: path.join(root, "config", "lua") },
  ];
  const found = [];
  for (const source of dirs) {
    let entries = [];
    try {
      entries = await fs.readdir(source.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^\d+\.lua$/i.test(entry.name)) continue;
      const appId = Number(path.basename(entry.name, ".lua"));
      const full = path.join(source.dir, entry.name);
      const stat = await fs.stat(full);
      found.push({
        app_id: appId,
        source: source.kind,
        path: full,
        bytes: stat.size,
        modified: stat.mtime.toISOString(),
        sha256: await sha256File(full),
      });
    }
  }
  return found;
}
async function installedManifests(root) {
  if (!root) return [];
  const dir = path.join(root, "steamapps");
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    const match = /^appmanifest_(\d+)\.acf$/i.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    const appId = Number(match[1]);
    const manifest = await readAppManifest(root, appId);
    rows.push({
      app_id: appId,
      name: manifest?.name || null,
      installdir: manifest?.installdir || null,
      buildid: manifest?.buildid || null,
      manifest_path: manifest?.path || path.join(dir, entry.name),
    });
  }
  return rows;
}

async function depotManifests(root) {
  if (!root) return [];
  const dir = path.join(root, "depotcache");
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    const match = /^(\d+)_(\d+)\.manifest$/i.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    const full = path.join(dir, entry.name);
    const stat = await fs.stat(full);
    rows.push({
      depot_id: Number(match[1]),
      manifest_id: match[2],
      path: full,
      bytes: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }
  return rows.sort((a, b) => a.depot_id - b.depot_id);
}

async function safeLuaToolsSettings() {
  const gui = luaToolsGuiRoot();
  const settings = gui ? await readJson(path.join(gui, "settings.json")) : null;
  if (!settings) return null;
  return {
    selected_mode: settings.SelectedMode ?? null,
    auto_update_apps: settings.AutoUpdateApps ?? null,
    fast_fetch: settings.FastFetch ?? null,
    start_with_windows: settings.StartWithWindows ?? null,
    minimize_to_tray: settings.MinimizeToTray ?? null,
    language: settings.Language ?? null,
  };
}

async function luaToolsPluginState() {
  const gui = luaToolsGuiRoot();
  const installed = gui
    ? await readJson(path.join(gui, "plugin", "installed.json"))
    : null;
  if (!installed) return null;
  return {
    tag: installed.Tag ?? null,
    dll_sha256: installed.DllSha ?? null,
    zip_sha256: installed.ZipSha ?? null,
  };
}

async function luaArtifactDetails(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    const activeManifests = [...text.matchAll(
      /^(?!\s*--)\s*setManifestid\((\d+),\s*"([^"]+)"/gim,
    )].map((match) => ({
      depot_id: Number(match[1]),
      manifest_id: match[2],
    }));
    const commentedManifests = [...text.matchAll(
      /^\s*--\s*setManifestid\((\d+),\s*"([^"]+)"/gim,
    )].map((match) => ({
      depot_id: Number(match[1]),
      manifest_id: match[2],
    }));
    const appIds = [...text.matchAll(/addappid\((\d+)/gi)].map((match) =>
      Number(match[1]),
    );
    return {
      path: file,
      sha256: await sha256File(file),
      app_ids: [...new Set(appIds)],
      addappid_count: appIds.length,
      active_manifest_refs: activeManifests,
      commented_manifest_refs: commentedManifests,
    };
  } catch {
    return null;
  }
}

async function luaVaultState(appId) {
  const gui = luaToolsGuiRoot();
  if (!gui) return null;
  const dir = path.join(gui, "luavault", String(appId));
  const index = await readJson(path.join(dir, "index.json"));
  if (!index) return null;
  const variants = [];
  for (const variant of Array.isArray(index.Variants) ? index.Variants : []) {
    const hash = String(variant.Hash || "").toLowerCase();
    const file = hash ? path.join(dir, hash + ".lua") : null;
    let fileState = null;
    if (file && existsSync(file)) {
      const stat = await fs.stat(file);
      fileState = {
        path: file,
        bytes: stat.size,
        sha256: await sha256File(file),
      };
    }
    variants.push({
      hash: hash || null,
      kind: variant.Kind ?? null,
      captured_at: variant.CapturedAt ?? null,
      depot_count: variant.DepotCount ?? null,
      dlc_count: variant.DlcCount ?? null,
      file: fileState,
    });
  }
  return { app_id: Number(index.AppId || appId), variants };
}

async function luaToolsDownloadHistory(appId) {
  const gui = luaToolsGuiRoot();
  const cache = gui ? await readJson(path.join(gui, "cache.json")) : null;
  const rows = Array.isArray(cache?.DownloadHistory) ? cache.DownloadHistory : [];
  return rows
    .filter((row) => Number(row?.AppId) === Number(appId))
    .map((row) => ({
      id: row.Id ?? null,
      kind: row.Kind ?? null,
      app_id: Number(row.AppId),
      title: row.Title ?? null,
      source: row.SubTitle ?? null,
      bytes: row.Bytes ?? null,
      status: row.Status ?? null,
      message: row.Message ?? null,
      completed_at_ms: row.CompletedAtMs ?? null,
      reveal_path: row.RevealPath ?? null,
    }));
}

async function luaToolsBackendEvidence(appId) {
  const gui = luaToolsGuiRoot();
  const file = gui ? path.join(gui, "plugin-backend.log") : null;
  if (!file) return [];
  try {
    const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/);
    const needle = String(appId);
    return lines.filter((line) => line.includes(needle)).slice(-80);
  } catch {
    return [];
  }
}

async function inspectLuaToolsApp(steam, appId) {
  const id = Number(appId);
  if (!Number.isInteger(id) || id <= 0)
    throw new Error("LuaTools inspect_app requires a valid app_id");
  const entries = (await luaEntries(steam)).filter((entry) => entry.app_id === id);
  const manifest = await readAppManifest(steam, id);
  const depotRows = await depotManifests(steam);
  const appDepotIds = new Set((manifest?.installed_depots || []).map((row) => row.depot_id));
  const entryDetails = [];
  for (const entry of entries) {
    entryDetails.push({
      ...entry,
      artifact: await luaArtifactDetails(entry.path),
    });
  }
  const referencedDepotIds = new Set();
  for (const entry of entryDetails) {
    for (const dep of entry.artifact?.active_manifest_refs || []) referencedDepotIds.add(dep.depot_id);
    for (const dep of entry.artifact?.commented_manifest_refs || []) referencedDepotIds.add(dep.depot_id);
    for (const dep of entry.artifact?.app_ids || []) referencedDepotIds.add(dep);
  }
  const relatedDepots = depotRows.filter(
    (row) => appDepotIds.has(row.depot_id) || referencedDepotIds.has(row.depot_id),
  );
  return {
    app_id: id,
    appmanifest: manifest,
    lua_entries: entryDetails,
    depot_manifests: relatedDepots,
    vault: await luaVaultState(id),
    download_history: await luaToolsDownloadHistory(id),
    backend_log_evidence: await luaToolsBackendEvidence(id),
    settings: await safeLuaToolsSettings(),
    plugin: await luaToolsPluginState(),
    read_only: true,
  };
}

function normalizeWindowsPath(value) {
  return String(value || "").replaceAll("/", "\\").toLowerCase();
}

function verifyLuaToolsInspection(state) {
  const active = state.lua_entries?.find((row) => row.source === "stplug-in")
    || state.lua_entries?.[0]
    || null;
  const vaultHashes = new Set(
    (state.vault?.variants || []).map((row) => String(row.hash || "").toLowerCase()),
  );
  const history = state.download_history || [];
  const completed = history.find((row) => String(row.status).toLowerCase() === "completed");
  const appDepots = state.appmanifest?.installed_depots || [];
  const depotKeys = new Set(
    (state.depot_manifests || []).map((row) => `${row.depot_id}:${row.manifest_id}`),
  );
  const missingDepotManifests = appDepots.filter(
    (row) => !depotKeys.has(`${row.depot_id}:${row.manifest_id}`),
  );
  const revealMatches =
    !completed?.reveal_path || !active?.path
      ? null
      : normalizeWindowsPath(completed.reveal_path) === normalizeWindowsPath(active.path);
  const vaultMatches =
    !active?.sha256 || vaultHashes.size === 0
      ? null
      : vaultHashes.has(String(active.sha256).toLowerCase());
  return {
    app_id: state.app_id,
    lua_present: Boolean(active),
    appmanifest_present: Boolean(state.appmanifest),
    completed_history_present: Boolean(completed),
    history_reveal_matches_active: revealMatches,
    vault_hash_matches_active: vaultMatches,
    installed_depot_manifest_count: appDepots.length,
    missing_installed_depot_manifests: missingDepotManifests,
    plugin_present: Boolean(state.plugin?.tag),
    selected_mode: state.settings?.selected_mode ?? null,
    verified:
      Boolean(active) &&
      Boolean(state.appmanifest) &&
      Boolean(completed) &&
      missingDepotManifests.length === 0 &&
      revealMatches !== false &&
      vaultMatches !== false,
  };
}

function launchDetached(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function luaToolsAction(args = {}) {
  const action = String(args.action || "status").toLowerCase();
  const paths = luaToolsPaths();
  const steam = steamRoot();
  const version = await readVersion(paths.root);

  if (action === "status") {
    return {
      action,
      installed: Boolean(paths.exe),
      executable: paths.exe,
      version,
      steam_root: steam,
      plugin_log_present: Boolean(steam && existsSync(path.join(steam, "luatools_loader.log"))),
      verified_local_install: Boolean(paths.exe),
    };
  }
  if (action === "inventory" || action === "list_managed") {
    const entries = await luaEntries(steam);
    const manifests = await installedManifests(steam);
    const depots = await depotManifests(steam);
    const names = new Map(manifests.map((row) => [row.app_id, row]));
    return {
      action: action === "list_managed" ? "inventory" : action,
      lua_entries: entries.map((entry) => ({
        ...entry,
        name: names.get(entry.app_id)?.name || null,
        installed_manifest_present: names.has(entry.app_id),
      })),
      lua_entry_count: entries.length,
      installed_apps: manifests,
      installed_app_count: manifests.length,
      depot_manifests: depots,
      depot_manifest_count: depots.length,
      settings: await safeLuaToolsSettings(),
      plugin: await luaToolsPluginState(),
      steam_root: steam,
      gui_root: luaToolsGuiRoot(),
      read_only: true,
    };
  }

  if (
    action === "inspect_app" ||
    action === "inspect_artifacts" ||
    action === "verify_state" ||
    action === "inspect_game"
  ) {
    let appId = Number(args.app_id);
    const query = String(args.query || "").trim().toLowerCase();
    if (!Number.isInteger(appId) || appId <= 0) {
      if (!query) throw new Error("LuaTools inspection requires app_id or query");
      const manifests = await installedManifests(steam);
      const match =
        manifests.find((row) => String(row.name || "").toLowerCase() === query) ||
        manifests.find((row) => String(row.name || "").toLowerCase().includes(query));
      if (!match) throw new Error("No matching installed Steam app was found");
      appId = match.app_id;
    }
    const state = await inspectLuaToolsApp(steam, appId);
    const verification = verifyLuaToolsInspection(state);
    if (action === "verify_state") {
      return {
        action,
        ...verification,
        read_only: true,
      };
    }
    if (action === "inspect_artifacts") {
      return {
        action,
        app_id: state.app_id,
        appmanifest: state.appmanifest,
        lua_entries: state.lua_entries,
        depot_manifests: state.depot_manifests,
        vault: state.vault,
        download_history: state.download_history,
        backend_log_evidence: state.backend_log_evidence,
        verification,
        read_only: true,
      };
    }
    return {
      action: action === "inspect_game" ? "inspect_app" : action,
      ...state,
      verification,
    };
  }

  if (action === "open") {
    if (!paths.exe) throw new Error("LuaTools is not installed");
    await launchDetached(paths.exe);
    return {
      action,
      launched: true,
      executable: paths.exe,
      version,
    };
  }

  throw new Error("Unsupported LuaTools action");
}
