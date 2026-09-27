/**
 * Optional YARA scan. Never auto-installs. Never uploads files.
 */

import { resolveToolPath } from "./detect.mjs";
import { securityResult } from "./evidence.mjs";
import { runCommand } from "./exec.mjs";

const MAX_MATCHES = 80;
const MAX_RECURSION = 3;

export function createYaraScanner({ exists, run, resolve = resolveToolPath } = {}) {
  return {
    async available() {
      const bin = resolve("yara", { exists });
      return { installed: Boolean(bin), path: bin };
    },
    async scan({
      target,
      rulesPath,
      recursion = 1,
    } = {}) {
      const avail = await this.available();
      if (!avail.installed) {
        return securityResult({
          tool: "security_yara_scan",
          available: false,
          error: "YARA is not installed.",
          observed: { installed: false, uploaded: false },
          unverified: ["YARA was not silently installed."],
        });
      }
      if (!rulesPath) {
        return securityResult({
          tool: "security_yara_scan",
          available: true,
          error: "A local YARA rules file is required.",
          observed: { installed: true, path: avail.path, uploaded: false },
        });
      }
      const exec = typeof run === "function" ? run : defaultYaraRun;
      const depth = Math.min(MAX_RECURSION, Math.max(0, Number(recursion) || 1));
      const raw = await exec({
        binary: avail.path,
        target,
        rulesPath,
        recursion: depth,
      });
      const matches = (raw.matches || []).slice(0, MAX_MATCHES).map((m) => ({
        rule: m.rule || m.name,
        tags: m.tags || [],
        meta: m.meta || {},
        offsets: (m.offsets || m.strings || []).slice(0, 20),
      }));
      return securityResult({
        tool: "security_yara_scan",
        available: true,
        observed: {
          installed: true,
          path: avail.path,
          target,
          rulesPath: rulesPath || null,
          recursion: depth,
          uploaded: false,
          matchCount: matches.length,
          matches,
        },
        assessment: matches.map((m) => `YARA rule ${m.rule} matched`),
        unverified: matches.length
          ? ["A rule match is not a malware confirmation."]
          : ["No YARA matches were observed."],
      });
    },
  };
}

export async function defaultYaraRun({
  binary,
  target,
  rulesPath,
  recursion = 1,
} = {}) {
  if (!binary || !target || !rulesPath)
    return { matches: [], error: "YARA arguments incomplete." };
  const args = ["-s", "-m"];
  if (recursion > 0) args.push("-r");
  args.push(rulesPath, target);
  const result = await runCommand(binary, args, { timeout: 30000 });
  return { matches: parseYaraOutput(result.output), output: result.output };
}

function parseYaraOutput(text) {
  const matches = [];
  let current = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const header = line.match(/^(\S+)\s+(\[.*\])\s+(.+)$/);
    const simple = !header && line.match(/^(\S+)\s+(.+)$/);
    if (header || (simple && !line.includes(":"))) {
      const rule = header ? header[1] : simple[1];
      current = { rule, tags: [], meta: {}, offsets: [] };
      if (header) {
        try {
          current.meta = JSON.parse(header[2]);
        } catch {
          current.meta = { raw: header[2].slice(0, 200) };
        }
      }
      matches.push(current);
      continue;
    }
    const off = line.match(/0x([0-9a-fA-F]+)/);
    if (current && off) current.offsets.push(parseInt(off[1], 16));
  }
  return matches;
}
