/**
 * Read-only Windows helpers for process/network snapshots.
 * Never injects or executes a target binary.
 */

import { spawn } from "node:child_process";

function runPs(command, { signal, timeout = 25000 } = {}) {
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
      if (output.length < 80000)
        output += chunk.toString().slice(0, 80000 - output.length);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function parseJson(output) {
  const text = String(output || "").trim();
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch {
    throw new Error("Windows helper returned unreadable JSON");
  }
}

export async function defaultProcessRunner({ pid = null, name = null, signal } = {}) {
  const filter = Number.isInteger(pid)
    ? `Where-Object { $_.ProcessId -eq ${Number(pid)} }`
    : name
      ? `Where-Object { $_.Name -eq '${String(name).replace(/'/g, "''")}' }`
      : "Select-Object -First 8";
  const command = `$p = @(Get-CimInstance Win32_Process | ${filter} | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate,WorkingSetSize); $out = foreach ($row in $p) { $mods = @(); $ports = @(); $sig = $null; $arch = $null; try { $mods = @(Get-Process -Id $row.ProcessId -Module -ErrorAction SilentlyContinue | Select-Object -First 80 ModuleName,FileName) } catch {}; try { $ports = @(Get-NetTCPConnection -OwningProcess $row.ProcessId -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State) } catch {}; if ($row.ExecutablePath) { try { $sig = [string](Get-AuthenticodeSignature -FilePath $row.ExecutablePath).Status } catch {} }; try { $arch = if ([Environment]::Is64BitOperatingSystem) { 'AMD64' } else { 'I386' } } catch {}; [pscustomobject]@{ pid=$row.ProcessId; parentPid=$row.ParentProcessId; name=$row.Name; path=$row.ExecutablePath; commandLine=$row.CommandLine; startTime=$row.CreationDate; memoryBytes=$row.WorkingSetSize; architecture=$arch; signatureStatus=$sig; modules=@($mods | ForEach-Object { [pscustomobject]@{ name=$_.ModuleName; path=$_.FileName } }); ports=@($ports | ForEach-Object { [pscustomobject]@{ protocol='tcp'; localAddress=$_.LocalAddress; localPort=$_.LocalPort; remoteAddress=$_.RemoteAddress; remotePort=$_.RemotePort; state=[string]$_.State } }) } }; $out | ConvertTo-Json -Compress -Depth 5`;
  const result = await runPs(command, { signal, timeout: 35000 });
  if (result.code !== 0)
    throw new Error((result.output || "process query failed").slice(0, 400));
  return parseJson(result.output).map((row) => ({
    pid: row.pid ?? row.ProcessId,
    parentPid: row.parentPid ?? row.ParentProcessId,
    name: row.name ?? row.Name,
    path: row.path ?? row.ExecutablePath,
    commandLine: row.commandLine ?? row.CommandLine,
    startTime: row.startTime ?? row.CreationDate,
    memoryBytes: row.memoryBytes ?? row.WorkingSetSize,
    architecture: row.architecture || null,
    signatureStatus: row.signatureStatus || null,
    modules: row.modules || [],
    ports: row.ports || [],
  }));
}

export async function defaultNetworkRunner({ signal } = {}) {
  const command = `$c = Get-NetTCPConnection -ErrorAction SilentlyContinue | Select-Object OwningProcess,LocalAddress,LocalPort,RemoteAddress,RemotePort,State; $u = Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Select-Object OwningProcess,LocalAddress,LocalPort; $i = Get-NetIPAddress -ErrorAction SilentlyContinue | Select-Object InterfaceAlias,IPAddress,AddressFamily; function NameOf($id){ try { (Get-Process -Id $id -ErrorAction SilentlyContinue).Name } catch { $null } }; [pscustomobject]@{ connections = @($c | ForEach-Object { [pscustomobject]@{ protocol='tcp'; pid=$_.OwningProcess; processName=(NameOf $_.OwningProcess); localAddress=$_.LocalAddress; localPort=$_.LocalPort; remoteAddress=$_.RemoteAddress; remotePort=$_.RemotePort; state=[string]$_.State } }); udp = @($u | ForEach-Object { [pscustomobject]@{ protocol='udp'; pid=$_.OwningProcess; processName=(NameOf $_.OwningProcess); localAddress=$_.LocalAddress; localPort=$_.LocalPort } }); interfaces = @($i) } | ConvertTo-Json -Compress -Depth 4`;
  const result = await runPs(command, { signal, timeout: 30000 });
  if (result.code !== 0)
    throw new Error((result.output || "network query failed").slice(0, 400));
  const parsed = parseJson(result.output)[0] || {};
  return {
    interfaces: parsed.interfaces || [],
    connections: [...(parsed.connections || []), ...(parsed.udp || [])],
  };
}
