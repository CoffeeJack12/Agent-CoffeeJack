import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function localAppData() {
  return process.env.LOCALAPPDATA || (
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Local")
      : null
  );
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
    return {
      path: file,
      name: text.match(/"name"\s+"([^"]+)"/i)?.[1] || null,
      installdir: text.match(/"installdir"\s+"([^"]+)"/i)?.[1] || null,
      buildid: text.match(/"buildid"\s+"([^"]+)"/i)?.[1] || null,
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
  if (action === "list_managed") {
    const entries = await luaEntries(steam);
    const manifests = await installedManifests(steam);
    const names = new Map(manifests.map((row) => [row.app_id, row]));
    return {
      action,
      entries: entries.map((entry) => ({
        ...entry,
        name: names.get(entry.app_id)?.name || null,
        installed_manifest_present: names.has(entry.app_id),
      })),
      count: entries.length,
      entitlement_verified: false,
      note:
        "These are local LuaTools/Steam configuration entries. Their presence does not by itself prove account ownership or entitlement.",
    };
  }

  if (action === "inspect_game") {
    const appId = Number(args.app_id);
    const query = String(args.query || "").trim().toLowerCase();
    if ((!Number.isInteger(appId) || appId <= 0) && !query)
      throw new Error("LuaTools inspect_game requires app_id or query");
    const entries = await luaEntries(steam);
    const manifests = await installedManifests(steam);
    const candidates = manifests.filter((row) =>
      Number.isInteger(appId) && appId > 0
        ? row.app_id === appId
        : String(row.name || "").toLowerCase().includes(query),
    );
    const ids = new Set(candidates.map((row) => row.app_id));
    if (Number.isInteger(appId) && appId > 0) ids.add(appId);
    return {
      action,
      query: args.query || null,
      requested_app_id: Number.isInteger(appId) && appId > 0 ? appId : null,
      games: await Promise.all(
        [...ids].map(async (id) => {
          const manifest = manifests.find((row) => row.app_id === id) || null;
          return {
            app_id: id,
            name: manifest?.name || null,
            installed_manifest: manifest,
            lua_entries: entries.filter((entry) => entry.app_id === id),
          };
        }),
      ),
      entitlement_verified: false,
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
