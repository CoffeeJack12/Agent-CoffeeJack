/**
 * Optional Ghidra headless adapter. Detect first. Never pretends it is installed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveToolPath } from "../detect.mjs";
import { runCommand, safeToken } from "../exec.mjs";

const MAX_FUNCTIONS = 80;
const MAX_DISASM = 8000;
const MAX_DECOMP = 8000;

export function createGhidraAdapter({
  exists,
  run,
  resolve = resolveToolPath,
} = {}) {
  return {
    name: "ghidra",
    async available() {
      const analyzeHeadless = resolve("analyzeHeadless", { exists });
      const ghidra = resolve("ghidra", { exists });
      const bin = analyzeHeadless || ghidra;
      return {
        installed: Boolean(bin),
        path: bin,
        tool: "ghidra",
      };
    },
    async analyze({
      file,
      projectDir,
      functionName,
      address,
      range,
      decompile = false,
    } = {}) {
      const avail = await this.available();
      if (!avail.installed) {
        return {
          available: false,
          tool: "ghidra",
          observed: { installed: false },
          unverified: ["Ghidra headless is not installed."],
        };
      }
      const exec = typeof run === "function" ? run : defaultGhidraRun;
      const project = path.join(projectDir, "ghidra-project");
      const result = await exec({
        binary: avail.path,
        file,
        project,
        functionName: functionName || null,
        address: address || null,
        range: range || null,
        decompile,
      });
      return {
        available: !result.error,
        tool: "ghidra",
        observed: {
          installed: true,
          path: avail.path,
          project,
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
          : ["Ghidra export is bounded; the original binary was not modified."],
      };
    },
  };
}

const GHIDRA_SCRIPT = `from ghidra.program.model.listing import FunctionManager
print("CJ_BEGIN")
fm = currentProgram.getFunctionManager()
n = 0
for f in fm.getFunctions(True):
    if n >= 80:
        break
    print("FN %s %s" % (f.getEntryPoint(), f.getName()))
    n += 1
print("CJ_END")
`;

export async function defaultGhidraRun({
  binary,
  file,
  project,
  functionName,
  address,
  range,
  decompile = false,
} = {}) {
  if (!binary || !file)
    return { error: "Ghidra binary or input file missing.", functions: [] };
  const parent = path.dirname(project);
  await fs.mkdir(parent, { recursive: true });
  const script = path.join(parent, "cj_export.py");
  await fs.writeFile(script, GHIDRA_SCRIPT, "utf8");
  const args = [
    parent,
    path.basename(project),
    "-import",
    file,
    "-analysisTimeoutPerFile",
    "45",
    "-deleteProject",
    "-postScript",
    script,
  ];
  const focus = safeToken(functionName) || safeToken(address) || safeToken(range);
  if (focus) args.push(focus);
  const result = await runCommand(binary, args, { timeout: 55000, cwd: parent });
  const body = extractMarked(result.output);
  const functions = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^FN\s+(\S+)\s+(.+)$/);
    if (m) functions.push({ address: m[1], name: m[2] });
  }
  return {
    functions,
    symbols: functions,
    imports: [],
    disassembly: body.slice(0, MAX_DISASM),
    decompilation: decompile ? body.slice(0, MAX_DECOMP) : "",
    error: result.code === 0 ? null : (result.output || "Ghidra headless failed").slice(0, 400),
  };
}

function extractMarked(text) {
  const s = String(text || "");
  const start = s.indexOf("CJ_BEGIN");
  const end = s.indexOf("CJ_END");
  if (start >= 0 && end > start) return s.slice(start + 8, end).trim();
  return s.slice(0, 2000);
}
