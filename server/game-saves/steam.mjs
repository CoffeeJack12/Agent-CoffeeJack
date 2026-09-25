import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function runPs(command, { signal, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Cancelled"));
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const stop = () => {
      try {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        child.kill();
      }
    };
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, timeout);
    const collect = (chunk) => {
      if (output.length < 20000)
        output += chunk.toString().slice(0, 20000 - output.length);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({ code, output });
    });
  });
}

function tokenizeVdf(text) {
  const tokens = [];
  const src = String(text || "");
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "{" || ch === "}") {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let out = "";
      i += 1;
      while (i < src.length) {
        if (src[i] === "\\" && i + 1 < src.length) {
          out += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === '"') {
          i += 1;
          break;
        }
        out += src[i];
        i += 1;
      }
      tokens.push(out);
      continue;
    }
    let ident = "";
    while (i < src.length && !/\s|[{}"]/.test(src[i])) {
      ident += src[i];
      i += 1;
    }
    if (ident) tokens.push(ident);
  }
  return tokens;
}

export function parseVdf(text) {
  const tokens = tokenizeVdf(text);
  let i = 0;
  const parseValue = () => {
    const token = tokens[i++];
    if (token === "{") {
      const obj = {};
      while (i < tokens.length && tokens[i] !== "}") {
        const key = tokens[i++];
        obj[key] = parseValue();
      }
      if (tokens[i] === "}") i += 1;
      return obj;
    }
    return token ?? "";
  };
  if (tokens[0] && tokens[1] === "{") {
    const key = tokens[i++];
    return { [key]: parseValue() };
  }
  return parseValue();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function libraryFoldersFromVdf(text) {
  const parsed = parseVdf(text);
  const root = parsed.libraryfolders || parsed.LibraryFolders || parsed;
  const folders = [];
  if (!root || typeof root !== "object") return folders;
  for (const [key, value] of Object.entries(root)) {
    if (value && typeof value === "object") {
      const folderPath = firstString(value.path, value.Path);
      if (folderPath) folders.push({ id: key, path: folderPath, apps: value.apps || {} });
    } else if (/^\d+$/.test(key) && typeof value === "string") {
      folders.push({ id: key, path: value, apps: {} });
    }
  }
  return folders;
}

export function appManifestFromAcf(text) {
  const parsed = parseVdf(text);
  const state = parsed.AppState || parsed.appstate || parsed;
  if (!state || typeof state !== "object") return null;
  return {
    appId: firstString(state.appid, state.AppID),
    name: firstString(state.name, state.installdir),
    installDir: firstString(state.installdir),
    buildId: firstString(state.buildid, state.BuildID),
    universe: firstString(state.universe),
    stateFlags: firstString(state.StateFlags),
  };
}

async function registrySteamRoots(signal) {
  if (process.platform !== "win32") return [];
  const command = [
    "foreach ($p in @('HKCU:\\Software\\Valve\\Steam','HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam','HKLM:\\SOFTWARE\\Valve\\Steam')) {",
    "  try {",
    "    $k = Get-ItemProperty -Path $p -ErrorAction Stop;",
    "    if ($k.SteamPath) { $k.SteamPath }",
    "    elseif ($k.InstallPath) { $k.InstallPath }",
    "  } catch {}",
    "}",
  ].join(" ");
  try {
    const result = await runPs(command, { signal });
    return String(result.output || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function defaultSteamGuesses() {
  const guesses = [];
  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    guesses.push(path.join(pf, "Steam"));
    if (process.env.ProgramFiles)
      guesses.push(path.join(process.env.ProgramFiles, "Steam"));
  } else {
    if (process.env.HOME) {
      guesses.push(path.join(process.env.HOME, ".steam", "steam"));
      guesses.push(path.join(process.env.HOME, ".local", "share", "Steam"));
    }
  }
  return guesses;
}

async function existingDir(candidate) {
  if (!candidate) return null;
  try {
    const real = await fs.realpath(candidate);
    const stat = await fs.stat(real);
    return stat.isDirectory() ? real : null;
  } catch {
    return existsSync(candidate) ? candidate : null;
  }
}

export async function discoverSteam({ signal, extraRoots = [] } = {}) {
  const tried = [];
  const roots = [];
  const seen = new Set();
  const add = async (candidate, source) => {
    if (!candidate) return;
    const normalized = path.resolve(String(candidate).replace(/[\\/]+$/, ""));
    if (seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());
    tried.push({ path: normalized, source });
    const real = await existingDir(normalized);
    if (real) roots.push({ path: real, source });
  };

  for (const root of extraRoots) await add(root, "injected");
  for (const root of await registrySteamRoots(signal)) await add(root, "registry");
  for (const root of defaultSteamGuesses()) await add(root, "common_path");

  const libraries = [];
  for (const root of roots) {
    const vdfPath = path.join(root.path, "steamapps", "libraryfolders.vdf");
    let folders = [{ id: "0", path: root.path, apps: {} }];
    try {
      const text = await fs.readFile(vdfPath, "utf8");
      const parsed = libraryFoldersFromVdf(text);
      if (parsed.length) folders = parsed;
    } catch {
      /* single-library Steam install */
    }
    for (const folder of folders) {
      const folderPath = await existingDir(folder.path);
      if (!folderPath) continue;
      libraries.push({
        path: folderPath,
        steamRoot: root.path,
        source: root.source,
        apps: folder.apps || {},
      });
    }
  }

  return { roots, libraries, tried };
}

export async function discoverSteamApp(appId, options = {}) {
  const id = String(appId);
  const steam = await discoverSteam(options);
  for (const library of steam.libraries) {
    const manifestPath = path.join(
      library.path,
      "steamapps",
      `appmanifest_${id}.acf`,
    );
    try {
      const text = await fs.readFile(manifestPath, "utf8");
      const manifest = appManifestFromAcf(text);
      if (!manifest?.installDir) continue;
      const installPath = path.join(
        library.path,
        "steamapps",
        "common",
        manifest.installDir,
      );
      const install = await existingDir(installPath);
      return {
        found: Boolean(install),
        appId: id,
        name: manifest.name,
        buildId: manifest.buildId || null,
        installDir: install,
        installDirName: manifest.installDir,
        libraryPath: library.path,
        steamRoot: library.steamRoot,
        manifestPath,
        source: library.source,
      };
    } catch {
      continue;
    }
  }
  return {
    found: false,
    appId: id,
    buildId: null,
    installDir: null,
    steam: { libraryCount: steam.libraries.length, rootCount: steam.roots.length },
  };
}
