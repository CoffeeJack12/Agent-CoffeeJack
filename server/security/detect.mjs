/**
 * Optional tool discovery. Never downloads or installs.
 */

import { existsSync } from "node:fs";
import path from "node:path";

const WINDOWS_HINTS = {
  ghidra: [
    "C:\\ghidra\\support\\analyzeHeadless.bat",
    "C:\\Program Files\\ghidra\\support\\analyzeHeadless.bat",
    "C:\\Program Files\\Ghidra\\support\\analyzeHeadless.bat",
  ],
  analyzeHeadless: [
    "C:\\ghidra\\support\\analyzeHeadless.bat",
    "C:\\Program Files\\ghidra\\support\\analyzeHeadless.bat",
  ],
  rizin: ["C:\\rizin\\bin\\rizin.exe"],
  "rz-bin": ["C:\\rizin\\bin\\rz-bin.exe"],
  radare2: ["C:\\radare2\\bin\\radare2.exe"],
  r2: ["C:\\radare2\\bin\\r2.exe"],
  yara: ["C:\\yara\\yara64.exe", "C:\\Program Files\\yara\\yara64.exe"],
  tshark: [
    "C:\\Program Files\\Wireshark\\tshark.exe",
    "C:\\Program Files (x86)\\Wireshark\\tshark.exe",
  ],
  pktmon: [
    "C:\\Windows\\System32\\pktmon.exe",
    "C:\\Windows\\Sysnative\\pktmon.exe",
  ],
};

export const OPTIONAL_TOOLS = Object.freeze([
  "ghidra",
  "analyzeHeadless",
  "rizin",
  "rz-bin",
  "radare2",
  "r2",
  "yara",
  "tshark",
  "pktmon",
]);

function pathEntries() {
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
}

function candidatesFor(name) {
  const exe =
    process.platform === "win32" && !name.endsWith(".exe") && !name.endsWith(".bat")
      ? `${name}.exe`
      : name;
  const fromPath = pathEntries().map((dir) => path.join(dir, exe));
  if (name === "analyzeHeadless" && process.platform === "win32") {
    fromPath.push(
      ...pathEntries().map((dir) => path.join(dir, "analyzeHeadless.bat")),
    );
  }
  const hints = process.platform === "win32" ? WINDOWS_HINTS[name] || [] : [];
  return [...fromPath, ...hints];
}

export function resolveToolPath(name, { exists = existsSync } = {}) {
  for (const candidate of candidatesFor(name)) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      /* ignore unreadable candidates */
    }
  }
  return null;
}

export function detectSecurityTools({ exists = existsSync } = {}) {
  const tools = {};
  for (const name of OPTIONAL_TOOLS) {
    const resolved = resolveToolPath(name, { exists });
    tools[name] = {
      name,
      installed: Boolean(resolved),
      path: resolved,
    };
  }
  return {
    platform: process.platform,
    tools,
    ghidra: Boolean(tools.ghidra.installed || tools.analyzeHeadless.installed),
    rizin: Boolean(tools.rizin.installed || tools["rz-bin"].installed || tools.radare2.installed || tools.r2.installed),
    yara: Boolean(tools.yara.installed),
    tshark: Boolean(tools.tshark.installed),
    pktmon: Boolean(tools.pktmon.installed),
  };
}
