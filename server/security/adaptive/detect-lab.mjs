/**
 * Detect lab runtimes and future adapters. Never auto-install.
 */

import { existsSync } from "node:fs";
import path from "node:path";

const LAB_RUNTIMES = [
  {
    id: "docker",
    names: ["docker", "docker.exe"],
    hints: ["C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"],
  },
  {
    id: "hyperv",
    names: ["vmms.exe"],
    hints: ["C:\\Windows\\System32\\vmms.exe"],
  },
  {
    id: "vmware",
    names: ["vmrun", "vmrun.exe"],
    hints: ["C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe"],
  },
  {
    id: "virtualbox",
    names: ["VBoxManage", "VBoxManage.exe"],
    hints: ["C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe"],
  },
  {
    id: "wsl",
    names: ["wsl", "wsl.exe"],
    hints: ["C:\\Windows\\System32\\wsl.exe"],
  },
];

export const FUTURE_ADAPTERS = Object.freeze([
  "owasp_juice_shop",
  "webgoat",
  "dvwa",
  "local_nginx",
  "local_apache",
  "modsecurity",
  "coraza",
  "suricata",
  "zeek",
  "opnsense",
  "pfsense",
]);

function pathEntries() {
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
}

function candidates(runtime) {
  const fromPath = runtime.names.flatMap((name) =>
    pathEntries().map((dir) => path.join(dir, name)),
  );
  const hints = process.platform === "win32" ? runtime.hints : [];
  return [...fromPath, ...hints];
}

export function detectLabEnvironment({ exists = existsSync } = {}) {
  const runtimes = {};
  for (const runtime of LAB_RUNTIMES) {
    let resolved = null;
    for (const candidate of candidates(runtime)) {
      try {
        if (exists(candidate)) {
          resolved = candidate;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    runtimes[runtime.id] = {
      id: runtime.id,
      installed: Boolean(resolved),
      path: resolved,
      autoInstall: false,
    };
  }
  if (exists("/.dockerenv")) runtimes.docker = { ...runtimes.docker, installed: true, path: runtimes.docker.path || "/.dockerenv" };
  const adapters = {};
  for (const id of FUTURE_ADAPTERS) {
    adapters[id] = {
      id,
      installed: false,
      requiredAtStartup: false,
      note: "Optional future lab adapter. CoffeeJack starts without it.",
    };
  }
  return {
    platform: process.platform,
    runtimes,
    adapters,
    requiredAtStartup: false,
  };
}
