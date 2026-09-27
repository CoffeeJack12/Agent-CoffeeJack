/**
 * Optional Rizin / radare2 adapter. Detect first. Never pretends it is installed.
 */

import { resolveToolPath } from "../detect.mjs";
import { runCommand, safeToken } from "../exec.mjs";

const MAX_FUNCTIONS = 80;
const MAX_DISASM = 8000;
const MAX_DECOMP = 4000;

export function createRizinAdapter({
  exists,
  run,
  resolve = resolveToolPath,
} = {}) {
  return {
    name: "rizin",
    async available() {
      const rizin = resolve("rizin", { exists });
      const rzBin = resolve("rz-bin", { exists });
      const radare2 = resolve("radare2", { exists });
      const r2 = resolve("r2", { exists });
      const bin = rizin || rzBin || radare2 || r2;
      return {
        installed: Boolean(bin),
        path: bin,
        tool: rizin ? "rizin" : rzBin ? "rz-bin" : radare2 ? "radare2" : r2 ? "r2" : "rizin",
      };
    },
    async analyze({ file, functionName, address, range, decompile = false } = {}) {
      const avail = await this.available();
      if (!avail.installed) {
        return {
          available: false,
          tool: "rizin",
          observed: { installed: false },
          unverified: ["Rizin / radare2 is not installed."],
        };
      }
      const exec = typeof run === "function" ? run : defaultRizinRun;
      const result = await exec({
        binary: avail.path,
        file,
        functionName: functionName || null,
        address: address || null,
        range: range || null,
        decompile,
      });
      return {
        available: !result.error,
        tool: avail.tool,
        observed: {
          installed: true,
          path: avail.path,
          functions: (result.functions || []).slice(0, MAX_FUNCTIONS),
          symbols: (result.symbols || []).slice(0, MAX_FUNCTIONS),
          imports: (result.imports || []).slice(0, MAX_FUNCTIONS),
          disassembly: String(result.disassembly || "").slice(0, MAX_DISASM),
          decompilation: decompile
            ? String(result.decompilation || "").slice(0, MAX_DECOMP)
            : null,
          originalBinaryModified: false,
        },
        unverified: result.error
          ? [String(result.error).slice(0, 300)]
          : ["Rizin output is bounded; the original binary was not modified."],
      };
    },
  };
}

export async function defaultRizinRun({
  binary,
  file,
  functionName,
  address,
  range,
  decompile = false,
} = {}) {
  if (!binary || !file)
    return { error: "Rizin binary or input file missing.", functions: [] };
  const focus =
    safeToken(functionName) ||
    safeToken(address) ||
    safeToken(range, { extra: "" });
  const commands = [
    "e bin.relocs.apply=true",
    "aaa",
    "afl",
    "ii",
    focus ? `pdf @ ${focus}` : "pdf @ main",
    decompile && focus ? `pdd @ ${focus}` : decompile ? "pdd @ main" : "",
  ]
    .filter(Boolean)
    .join(";");
  const result = await runCommand(binary, ["-q", "-c", commands, file], {
    timeout: 40000,
  });
  return {
    functions: [],
    symbols: [],
    imports: [],
    disassembly: result.output.slice(0, MAX_DISASM),
    decompilation: decompile ? result.output.slice(0, MAX_DECOMP) : "",
    error: result.code === 0 ? null : (result.output || "Rizin failed").slice(0, 400),
  };
}
