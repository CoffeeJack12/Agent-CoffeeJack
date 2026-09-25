/**
 * Read-only Windows PC diagnostics.
 * Prefer these fixed helpers over model-invented shell commands.
 */

import { spawn } from "node:child_process";

const DRIVE_RE = /^[A-Za-z]$/;

export function normalizeDriveLetter(input) {
  const raw = String(input || "")
    .trim()
    .replace(/^["']|["']$/g, "");
  const m = raw.match(/^([A-Za-z])[:\\\/]*$/);
  if (!m) return null;
  return m[1].toUpperCase();
}

export function assertValidDrive(input) {
  const letter = normalizeDriveLetter(input);
  if (!letter || !DRIVE_RE.test(letter)) {
    const err = new Error(
      "Invalid drive. Use a single local drive letter such as C or C:.",
    );
    err.code = "invalid_drive";
    throw err;
  }
  return letter;
}

function runPs(command, { signal, timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Cancelled"));
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let killed = false;
    const stop = () => {
      killed = true;
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
      resolve({ code, output, stopped: killed });
    });
  });
}

async function psJson(command, opts = {}) {
  const result = await runPs(command, opts);
  if (result.stopped)
    throw new Error("Diagnostic command timed out or was cancelled");
  if (result.code !== 0)
    throw new Error(
      `Diagnostic command failed (exit ${result.code}): ${(result.output || "").slice(0, 500)}`,
    );
  const text = String(result.output || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function bytesToGiB(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.round((v / 1024 ** 3) * 100) / 100;
}

function spaceStatus(freePct) {
  if (freePct == null) return "unknown";
  if (freePct < 5) return "critically_low";
  if (freePct < 15) return "low";
  return "enough";
}

/** Disk capacity for one local drive letter. */
export async function getDiskUsage(driveInput, opts = {}) {
  if (process.platform !== "win32")
    throw new Error("Disk diagnostics currently support Windows only");
  const drive = assertValidDrive(driveInput);
  const data = await psJson(
    `$d=Get-PSDrive -Name '${drive}' -ErrorAction Stop; [pscustomobject]@{Drive=$d.Name; UsedBytes=[int64]$d.Used; FreeBytes=[int64]$d.Free; Provider=$d.Provider.Name} | ConvertTo-Json -Compress`,
    opts,
  );
  if (!data || data.raw) throw new Error(`Could not read drive ${drive}:`);
  const used = Number(data.UsedBytes) || 0;
  const free = Number(data.FreeBytes) || 0;
  const total = used + free;
  const freePct = total > 0 ? Math.round((free / total) * 1000) / 10 : null;
  return {
    section: "disk",
    drive: `${drive}:`,
    totalBytes: total,
    usedBytes: used,
    freeBytes: free,
    totalGiB: bytesToGiB(total),
    usedGiB: bytesToGiB(used),
    freeGiB: bytesToGiB(free),
    freePercent: freePct,
    status: spaceStatus(freePct),
    readOnly: true,
  };
}

export async function getSystemMemory(opts = {}) {
  if (process.platform !== "win32")
    throw new Error("Memory diagnostics currently support Windows only");
  const data = await psJson(
    `$os=Get-CimInstance Win32_OperatingSystem; $cs=Get-CimInstance Win32_ComputerSystem; [pscustomobject]@{TotalBytes=[int64]$cs.TotalPhysicalMemory; FreeBytes=[int64]$os.FreePhysicalMemory*1KB} | ConvertTo-Json -Compress`,
    opts,
  );
  const total = Number(data?.TotalBytes) || 0;
  const free = Number(data?.FreeBytes) || 0;
  const used = Math.max(0, total - free);
  const freePct = total > 0 ? Math.round((free / total) * 1000) / 10 : null;
  return {
    section: "memory",
    totalBytes: total,
    usedBytes: used,
    freeBytes: free,
    totalGiB: bytesToGiB(total),
    usedGiB: bytesToGiB(used),
    freeGiB: bytesToGiB(free),
    freePercent: freePct,
    status: freePct != null && freePct < 10 ? "low" : "ok",
    readOnly: true,
  };
}

export async function getCpuStatus(opts = {}) {
  if (process.platform !== "win32")
    throw new Error("CPU diagnostics currently support Windows only");
  const data = await psJson(
    `$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1; [pscustomobject]@{Name=$cpu.Name; Cores=$cpu.NumberOfCores; Logical=$cpu.NumberOfLogicalProcessors; LoadPercent=$cpu.LoadPercentage; MaxClockMHz=$cpu.MaxClockSpeed} | ConvertTo-Json -Compress`,
    opts,
  );
  return {
    section: "cpu",
    name: data?.Name || null,
    cores: data?.Cores ?? null,
    logicalProcessors: data?.Logical ?? null,
    loadPercent: data?.LoadPercent ?? null,
    maxClockMHz: data?.MaxClockMHz ?? null,
    readOnly: true,
  };
}

export async function getGpuStatus(opts = {}) {
  if (process.platform !== "win32")
    throw new Error("GPU diagnostics currently support Windows only");
  const data = await psJson(
    `$gpus=@(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{Name=$_.Name; AdapterRAM=$_.AdapterRAM; DriverVersion=$_.DriverVersion} }); if($gpus.Count -eq 1){$gpus[0]|ConvertTo-Json -Compress} else {$gpus|ConvertTo-Json -Compress}`,
    opts,
  );
  const list = Array.isArray(data) ? data : data ? [data] : [];
  return {
    section: "gpu",
    adapters: list.map((g) => ({
      name: g.Name || null,
      adapterRamBytes: Number(g.AdapterRAM) || null,
      adapterRamGiB: bytesToGiB(g.AdapterRAM),
      driverVersion: g.DriverVersion || null,
    })),
    readOnly: true,
  };
}

export async function getWindowsUptime(opts = {}) {
  if (process.platform !== "win32")
    throw new Error("Uptime diagnostics currently support Windows only");
  const data = await psJson(
    `$os=Get-CimInstance Win32_OperatingSystem; $boot=$os.LastBootUpTime; $uptime=[int]((Get-Date)-$boot).TotalSeconds; [pscustomobject]@{LastBootUpTime=$boot.ToString('o'); UptimeSeconds=$uptime} | ConvertTo-Json -Compress`,
    opts,
  );
  const seconds = Number(data?.UptimeSeconds) || 0;
  return {
    section: "uptime",
    lastBootUpTime: data?.LastBootUpTime || null,
    uptimeSeconds: seconds,
    uptimeHours: Math.round((seconds / 3600) * 10) / 10,
    readOnly: true,
  };
}

export async function getNetworkStatus(opts = {}) {
  if (process.platform !== "win32")
    throw new Error("Network diagnostics currently support Windows only");
  const data = await psJson(
    `$c=Get-NetIPConfiguration; @($c | ForEach-Object { [pscustomobject]@{Interface=$_.InterfaceAlias; IPv4=($_.IPv4Address.IPAddress -join ','); Gateway=($_.IPv4DefaultGateway.NextHop -join ','); DNS=($_.DNSServer.ServerAddresses -join ',')} }) | ConvertTo-Json -Compress`,
    opts,
  );
  const interfaces = Array.isArray(data) ? data : data ? [data] : [];
  return {
    section: "network",
    interfaces,
    note: "Network status only — does not prove overall PC health.",
    readOnly: true,
  };
}

export async function getHardwareSummary(opts = {}) {
  if (process.platform !== "win32")
    throw new Error("Hardware diagnostics currently support Windows only");
  const data = await psJson(
    `Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,TotalPhysicalMemory,NumberOfLogicalProcessors | ConvertTo-Json -Compress`,
    opts,
  );
  return {
    section: "hardware",
    manufacturer: data?.Manufacturer || null,
    model: data?.Model || null,
    totalPhysicalMemory: data?.TotalPhysicalMemory ?? null,
    numberOfLogicalProcessors: data?.NumberOfLogicalProcessors ?? null,
    readOnly: true,
  };
}

/**
 * Structured local PC health scan (read-only). Network is one facet, not the whole.
 */
export async function getPcHealthSummary(opts = {}) {
  if (process.platform !== "win32")
    throw new Error("PC health diagnostics currently support Windows only");
  const checks = {};
  const concerns = [];
  const errors = [];

  async function run(name, fn) {
    try {
      checks[name] = await fn();
    } catch (error) {
      errors.push({
        check: name,
        error: String(error.message || error).slice(0, 300),
      });
      checks[name] = {
        section: name,
        error: String(error.message || error).slice(0, 300),
      };
    }
  }

  await run("cpu", () => getCpuStatus(opts));
  await run("memory", () => getSystemMemory(opts));
  await run("disk", () => getDiskUsage("C", opts));
  await run("gpu", () => getGpuStatus(opts));
  await run("uptime", () => getWindowsUptime(opts));
  await run("network", () => getNetworkStatus(opts));

  if (checks.memory?.status === "low")
    concerns.push("Available RAM is low (<10% free).");
  if (checks.disk?.status === "critically_low")
    concerns.push("C: free space is critically low (<5%).");
  else if (checks.disk?.status === "low")
    concerns.push("C: free space is low (<15%).");
  if (
    typeof checks.cpu?.loadPercent === "number" &&
    checks.cpu.loadPercent >= 90
  )
    concerns.push(`CPU load is high (${checks.cpu.loadPercent}%).`);
  if (errors.length)
    concerns.push(`${errors.length} diagnostic check(s) failed to complete.`);

  return {
    section: "health",
    readOnly: true,
    checks,
    concerns,
    networkHealthyAlone: Boolean(
      checks.network?.interfaces?.some((i) => i.IPv4),
    ),
    overall:
      concerns.length === 0 && errors.length === 0
        ? "No obvious concerns found in the checks that completed."
        : concerns.length
          ? "Concerns found — see concerns list."
          : "Partial diagnostics only; do not claim full PC health.",
    disclaimer:
      "A successful network ping alone is never enough to conclude the PC is healthy.",
  };
}

/** Detect bash/cmd operators that break Windows PowerShell. */
export function detectShellMismatch(command = "") {
  const cmd = String(command || "");
  const issues = [];
  if (cmd.includes("&&"))
    issues.push({
      code: "bash_and",
      message:
        "PowerShell does not accept bash '&&'. Use ';' or separate commands. Prefer inspect_pc for PC diagnostics.",
      rewrite: cmd.replace(/&&/g, ";"),
    });
  if (/\s\|\|\s/.test(cmd))
    issues.push({
      code: "bash_or",
      message:
        "PowerShell does not accept bash '||'. Prefer if/else or separate commands.",
    });
  if (/\b(?:ls|cat|grep|rm\s+-rf|chmod|sudo)\b/.test(cmd))
    issues.push({
      code: "unix_cmd",
      message:
        "Unix-style commands are not valid PowerShell here. Use Get-ChildItem, Get-Content, or inspect_pc helpers.",
    });
  return issues;
}

export function formatDiskAnswer(disk) {
  if (!disk || disk.error) return String(disk?.error || "Disk check failed.");
  const statusLabel =
    {
      enough: "Enough space",
      low: "Low space",
      critically_low: "Critically low space",
      unknown: "Unknown",
    }[disk.status] || disk.status;
  return [
    `${disk.drive} Drive`,
    `Total: ${disk.totalGiB} GiB`,
    `Used: ${disk.usedGiB} GiB`,
    `Free: ${disk.freeGiB} GiB`,
    `Free space: ${disk.freePercent}%`,
    "",
    `Status: ${statusLabel}`,
  ].join("\n");
}

/** Route natural-language PC / disk checks to inspect_pc helpers. */
export function classifyPcDiagnosticIntent(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  // Disk / C: space (English + Arabic)
  if (
    /(?:check|inspect|look\s*at|how\s+much\s+space|disk\s+space|free\s+space).{0,40}\b(?:c\s*:?\s*(?:drive)?|drive\s*c)\b/i.test(
      trimmed,
    ) ||
    /\b(?:c\s*:?\s*drive|drive\s*c|c:)\b.{0,40}(?:check|inspect|space|free)/i.test(
      trimmed,
    ) ||
    /(?:شيك|افحص|فحص).{0,20}(?:السي|سي\s*:?|القرص|مساحة)/i.test(trimmed) ||
    /(?:كم\s+المساحة|مساحة\s+(?:القرص|السي|c))/i.test(trimmed) ||
    /^(?:check\s+(?:my\s+)?c(?:\s*drive)?|check\s+c:)$/i.test(trimmed)
  ) {
    const driveMatch = trimmed.match(/\b([A-Za-z])\s*:?\s*(?:drive)?\b/);
    const arabicC = /سي|السي/.test(trimmed);
    const drive = arabicC
      ? "C"
      : normalizeDriveLetter(driveMatch?.[1] || "C") || "C";
    return {
      kind: "disk",
      section: "disk",
      drive,
      effectiveIntent: `Check ${drive}: drive free/used/total space (read-only).`,
      directive: [
        "PC DISK DIAGNOSTIC TURN.",
        `Call inspect_pc once with section=\"disk\" and drive=\"${drive}\".`,
        "Do not use terminal for this. Do not invent filenames or paths.",
        "After the tool returns, answer with Total / Used / Free / Free space % and Status.",
        "Do not claim other health metrics were checked.",
      ].join("\n"),
    };
  }

  // Network-only (distinct from overall PC health)
  if (
    /^(?:check|inspect|test).{0,20}(?:my\s+)?(?:network|internet|wifi|connection)\b/i.test(
      trimmed,
    ) ||
    /(?:شيك|افحص|فحص).{0,20}(?:الشبكة|الإنترنت|الانترنت|الاتصال)/i.test(
      trimmed,
    )
  ) {
    return {
      kind: "network",
      section: "network",
      effectiveIntent: "Check network status only (read-only).",
      directive: [
        "NETWORK DIAGNOSTIC TURN (not overall PC health).",
        'Call inspect_pc once with section="network".',
        "Do not claim the whole PC is healthy from network alone.",
        "Do not use terminal ping as a substitute for overall PC health.",
      ].join("\n"),
    };
  }

  // Overall PC health / concerns
  if (
    /(?:check|inspect|diagnose).{0,40}(?:my\s+)?(?:pc|computer|machine|system)\b/i.test(
      trimmed,
    ) ||
    /(?:any\s+)?concerns?.{0,20}(?:in\s+)?(?:my\s+)?(?:pc|computer)/i.test(
      trimmed,
    ) ||
    /(?:is\s+)?(?:my\s+)?(?:pc|computer|machine)\s+(?:okay|ok|healthy|fine)/i.test(
      trimmed,
    ) ||
    /(?:افحص|فحص|شيك).{0,20}(?:جهازي|الكمبيوتر|الحاسوب|الكمبيوتر)/i.test(
      trimmed,
    ) ||
    /(?:جهازي|الكمبيوتر).{0,20}(?:سليم|تمام|فيه\s*مشكلة)/i.test(trimmed)
  ) {
    return {
      kind: "pc_health",
      section: "health",
      effectiveIntent:
        "Run a structured read-only PC health diagnostic (CPU, RAM, disk, GPU, uptime, network).",
      directive: [
        "PC HEALTH DIAGNOSTIC TURN.",
        'Call inspect_pc once with section="health".',
        "Do NOT use terminal. Do NOT use ping alone.",
        "A successful network check does NOT mean the PC has no concerns.",
        "Report each completed check. Distinguish network status from overall PC health.",
        "Only say there are no concerns if the health tool's concerns list is empty.",
      ].join("\n"),
    };
  }

  return null;
}

const INSPECT_SECTIONS = new Set([
  "network",
  "hardware",
  "disk",
  "memory",
  "cpu",
  "gpu",
  "uptime",
  "health",
]);

export function isInspectSection(section) {
  return INSPECT_SECTIONS.has(String(section || "").toLowerCase());
}

/**
 * Run a named inspect_pc section. Returns structured data + display text.
 */
export async function runInspectSection(section, args = {}, opts = {}) {
  const sec = String(section || "").toLowerCase();
  if (!INSPECT_SECTIONS.has(sec))
    throw new Error(
      `Unknown diagnostic section. Use one of: ${[...INSPECT_SECTIONS].join(", ")}`,
    );

  let data;
  if (sec === "network") data = await getNetworkStatus(opts);
  else if (sec === "hardware") data = await getHardwareSummary(opts);
  else if (sec === "disk")
    data = await getDiskUsage(args.drive || "C", opts);
  else if (sec === "memory") data = await getSystemMemory(opts);
  else if (sec === "cpu") data = await getCpuStatus(opts);
  else if (sec === "gpu") data = await getGpuStatus(opts);
  else if (sec === "uptime") data = await getWindowsUptime(opts);
  else data = await getPcHealthSummary(opts);

  const display =
    sec === "disk"
      ? formatDiskAnswer(data)
      : JSON.stringify(data, null, 2);

  return {
    code: 0,
    stopped: false,
    output: display,
    data,
    readOnly: true,
  };
}
