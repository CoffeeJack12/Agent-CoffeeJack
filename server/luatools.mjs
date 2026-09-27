import fs from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

export const LUATOOLS_PAGES = Object.freeze([
  "Home",
  "Add",
  "Manage",
  "Depots",
  "Mode",
  "Fixes",
  "Plugin",
  "Downloads",
  "Settings",
]);

function defaults(overrides = {}) {
  const localAppData = overrides.localAppData || process.env.LOCALAPPDATA || "";
  const appData = overrides.appData || process.env.APPDATA || "";
  const pf86 =
    overrides.programFilesX86 ||
    process.env["ProgramFiles(x86)"] ||
    "C:\\Program Files (x86)";
  const installRoot =
    overrides.installRoot || path.join(localAppData, "LuaTools");
  const dataRoot =
    overrides.dataRoot || path.join(appData, "LuaToolsGui");
  const steamCandidates = [
    overrides.steamRoot,
    path.join(pf86, "Steam"),
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Steam") : null,
    "C:\\Program Files (x86)\\Steam",
    "C:\\Program Files\\Steam",
  ].filter(Boolean);
  const steamRoot =
    overrides.steamRoot ||
    steamCandidates.find((candidate) =>
      existsSync(path.join(candidate, "steam.exe")),
    ) ||
    steamCandidates[0];
  return {
    localAppData,
    appData,
    installRoot,
    currentRoot: path.join(installRoot, "current"),
    dataRoot,
    steamRoot,
  };
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
async function readVersion(currentRoot) {
  try {
    const xml = await fs.readFile(path.join(currentRoot, "sq.version"), "utf8");
    return xml.match(/<version>([^<]+)<\/version>/i)?.[1] || null;
  } catch {
    return null;
  }
}

function safeSettings(settings) {
  if (!settings || typeof settings !== "object") return {};
  return {
    selectedMode: settings.SelectedMode ?? null,
    autoUpdateApps: settings.AutoUpdateApps ?? null,
    donateKeys: settings.DonateKeys === true,
    language: settings.Language ?? null,
    startWithWindows: settings.StartWithWindows ?? null,
    minimizeToTray: settings.MinimizeToTray ?? null,
    fastFetch: settings.FastFetch ?? null,
    hubcapConfigured: Boolean(settings.HubcapApiKey),
  };
}

async function processRunning(name = "LuaTools") {
  if (process.platform !== "win32") return false;
  const script = `$p=Get-Process -Name '${name.replaceAll("'", "''")}' -ErrorAction SilentlyContinue; if($p){'true'}else{'false'}`;
  try {
    const out = await runPowerShell(script, { timeout: 5000 });
    return out.trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

async function runPowerShell(script, { timeout = 12000, signal } = {}) {
  if (process.platform !== "win32")
    throw new Error("LuaTools desktop integration currently supports Windows");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("LuaTools PowerShell helper timed out"));
    }, timeout);
    const abort = () => {
      child.kill();
      reject(new Error("Cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `PowerShell exited ${code}`));
    });
  });
}
async function gameName(dataRoot, appId) {
  const detail = await readJson(path.join(dataRoot, "details", `${appId}.json`));
  return typeof detail?.name === "string" ? detail.name : null;
}

export async function luaToolsStatus(overrides = {}) {
  const p = defaults(overrides);
  const exe = path.join(p.currentRoot, "LuaTools.exe");
  const settings = await readJson(path.join(p.dataRoot, "settings.json"), {});
  const plugin = await readJson(
    path.join(p.dataRoot, "plugin", "installed.json"),
    null,
  );
  let activeCount = 0;
  try {
    activeCount = (
      await fs.readdir(path.join(p.steamRoot, "config", "stplug-in"))
    ).filter((name) => /^\d+\.lua$/i.test(name)).length;
  } catch {
    activeCount = 0;
  }
  return {
    ok: true,
    installed: existsSync(exe),
    exePath: existsSync(exe) ? exe : null,
    version: await readVersion(p.currentRoot),
    running:
      typeof overrides.running === "boolean"
        ? overrides.running
        : await processRunning(),
    dataRootFound: existsSync(p.dataRoot),
    loggedIn: existsSync(path.join(p.dataRoot, "auth.dat")),
    steamDetected: existsSync(path.join(p.steamRoot, "steam.exe")),
    steamRoot: existsSync(path.join(p.steamRoot, "steam.exe"))
      ? p.steamRoot
      : null,
    activeLuaCount: activeCount,
    settings: safeSettings(settings),
    plugin: plugin
      ? {
          installed: true,
          version: plugin.Tag ?? null,
          dllSha256: plugin.DllSha ?? null,
        }
      : { installed: false, version: null, dllSha256: null },
  };
}

export async function listLuaToolsManaged(overrides = {}) {
  const p = defaults(overrides);
  const activeDir = path.join(p.steamRoot, "config", "stplug-in");
  let files = [];
  try {
    files = (await fs.readdir(activeDir)).filter((name) =>
      /^\d+\.lua$/i.test(name),
    );
  } catch {
    files = [];
  }
  const entries = [];
  for (const file of files.sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]))) {
    const appId = file.replace(/\.lua$/i, "");
    const full = path.join(activeDir, file);
    const stat = await fs.stat(full);
    const vault = await readJson(
      path.join(p.dataRoot, "luavault", appId, "index.json"),
      null,
    );
    entries.push({
      appId,
      name: await gameName(p.dataRoot, appId),
      bytes: stat.size,
      sha256: await sha256File(full),
      vaultVariants: Array.isArray(vault?.Variants) ? vault.Variants.length : 0,
      active: true,
    });
  }
  return { ok: true, count: entries.length, entries };
}
export async function inspectLuaToolsGame(appId, overrides = {}) {
  const id = String(appId || "").trim();
  if (!/^\d+$/.test(id)) throw new Error("LuaTools appId must be numeric");
  const p = defaults(overrides);
  const activeLua = path.join(p.steamRoot, "config", "stplug-in", `${id}.lua`);
  const legacyLua = path.join(p.steamRoot, "config", "lua", `${id}.lua`);
  const detail = await readJson(path.join(p.dataRoot, "details", `${id}.json`), null);
  const vault = await readJson(path.join(p.dataRoot, "luavault", id, "index.json"), null);
  const manifest = path.join(p.steamRoot, "steamapps", `appmanifest_${id}.acf`);
  const active = existsSync(activeLua);
  return {
    ok: true,
    appId: id,
    name: typeof detail?.name === "string" ? detail.name : null,
    active,
    activeLuaSha256: active ? await sha256File(activeLua) : null,
    legacyLuaPresent: existsSync(legacyLua),
    steamManifestPresent: existsSync(manifest),
    vault: vault
      ? {
          variants: (vault.Variants || []).map((v) => ({
            hash: v.Hash ?? null,
            kind: v.Kind ?? null,
            capturedAt: v.CapturedAt ?? null,
            depotCount: v.DepotCount ?? null,
            dlcCount: v.DlcCount ?? null,
          })),
        }
      : { variants: [] },
  };
}

export async function openLuaTools(overrides = {}, { signal } = {}) {
  const p = defaults(overrides);
  const exe = path.join(p.currentRoot, "LuaTools.exe");
  if (!existsSync(exe)) throw new Error("LuaTools.exe was not found");
  if (await processRunning()) return { ok: true, launched: false, alreadyRunning: true };
  const child = spawn(exe, [], {
    detached: true,
    windowsHide: false,
    stdio: "ignore",
  });
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 900));
  if (signal?.aborted) throw new Error("Cancelled");
  return {
    ok: true,
    launched: true,
    alreadyRunning: false,
    running: await processRunning(),
  };
}
function navigationScript(exe, page) {
  const qExe = exe.replaceAll("'", "''");
  const qPage = page.replaceAll("'", "''");
  return `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LuaToolsNav {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd,int nCmdShow);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint data,UIntPtr extra);
 public static void Click(int x,int y){SetCursorPos(x,y); mouse_event(0x0002,0,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(70); mouse_event(0x0004,0,0,0,UIntPtr.Zero);}
}
'@
$p=Get-Process LuaTools -ErrorAction SilentlyContinue | Select-Object -First 1
if(-not $p){ Start-Process -FilePath '${qExe}'; Start-Sleep -Seconds 2; $p=Get-Process LuaTools -ErrorAction Stop | Select-Object -First 1 }
[LuaToolsNav]::ShowWindow($p.MainWindowHandle,9)|Out-Null
[LuaToolsNav]::SetForegroundWindow($p.MainWindowHandle)|Out-Null
Start-Sleep -Milliseconds 250
$root=[System.Windows.Automation.AutomationElement]::RootElement
$pc=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$p.Id)
$win=$root.FindFirst([System.Windows.Automation.TreeScope]::Children,$pc)
if(-not $win){throw 'LuaTools window not found'}
$c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'${qPage}')
$e=$win.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$c)
if(-not $e){throw 'LuaTools page not found'}
$r=$e.Current.BoundingRectangle
[LuaToolsNav]::Click([int]($r.X+$r.Width/2),[int]($r.Y+$r.Height/2))
Start-Sleep -Milliseconds 650
$all=$win.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
$skip=@('Home','Add','Manage','Depots','Mode','Fixes','Plugin','Restart Steam','Downloads','Settings','LuaTools')
$names=@()
for($i=0;$i -lt $all.Count;$i++){
  $n=$all.Item($i).Current.Name
  if(
    -not $n -or
    $skip -contains $n -or
    $n -eq '?' -or
    $n -match '@' -or
    $n -match '^Signed in as ' -or
    $n -match '^v\d' -or
    $n -match '^LuaToolsGui\.ViewModels\.'
  ){continue}
  if(-not $names.Contains($n)){$names += $n}
}
[pscustomobject]@{page='${qPage}';visible=$names[0..([Math]::Min($names.Count-1,79))]} | ConvertTo-Json -Depth 3 -Compress
`;
}

export async function navigateLuaTools(page, overrides = {}, { signal } = {}) {
  if (!LUATOOLS_PAGES.includes(page))
    throw new Error("Unsupported LuaTools page");
  const p = defaults(overrides);
  const exe = path.join(p.currentRoot, "LuaTools.exe");
  if (!existsSync(exe)) throw new Error("LuaTools.exe was not found");
  const out = await runPowerShell(navigationScript(exe, page), {
    timeout: 15000,
    signal,
  });
  try {
    return { ok: true, ...JSON.parse(out.trim()) };
  } catch {
    return { ok: true, page, visible: [] };
  }
}

export async function runLuaToolsAction(args = {}, options = {}) {
  const action = String(args.action || "status");
  if (action === "status") return luaToolsStatus(options.paths);
  if (action === "list_managed") return listLuaToolsManaged(options.paths);
  if (action === "inspect_game")
    return inspectLuaToolsGame(args.appId, options.paths);
  if (action === "open")
    return openLuaTools(options.paths, { signal: options.signal });
  if (action === "navigate")
    return navigateLuaTools(args.page, options.paths, {
      signal: options.signal,
    });
  throw new Error(`Unsupported LuaTools action: ${action}`);
}
