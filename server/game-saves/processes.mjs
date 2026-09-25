import { spawn } from "node:child_process";
import path from "node:path";

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
      if (output.length < 40000)
        output += chunk.toString().slice(0, 40000 - output.length);
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

function normalizePath(p) {
  return String(p || "").replace(/[\\/]+/g, path.sep).toLowerCase();
}

export function processUnderInstall(processes, installDir) {
  if (!installDir) return { running: false, matches: [] };
  const root = normalizePath(installDir);
  const matches = (processes || []).filter((proc) => {
    const exe = normalizePath(proc.executablePath || proc.ExecutablePath || "");
    if (!exe) return false;
    return exe === root || exe.startsWith(`${root}${path.sep}`) || exe.startsWith(`${root}/`) || exe.startsWith(`${root}\\`);
  });
  return {
    running: matches.length > 0,
    matches: matches.map((proc) => ({
      pid: proc.ProcessId ?? proc.pid ?? null,
      name: proc.Name || proc.name || null,
      executablePath: proc.ExecutablePath || proc.executablePath || null,
    })),
  };
}

export async function listRunningProcesses({ signal, injected } = {}) {
  if (Array.isArray(injected)) return injected;
  if (process.platform !== "win32") return [];
  const command =
    "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress";
  const result = await runPs(command, { signal });
  if (result.code !== 0) return [];
  const text = String(result.output || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export async function inspectInstallProcess(installDir, options = {}) {
  const processes = await listRunningProcesses(options);
  return processUnderInstall(processes, installDir);
}
