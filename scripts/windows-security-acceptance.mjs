/**
 * Read-only Windows acceptance for the reverse-engineering toolkit.
 * Inspects a harmless signed Microsoft binary. Never attaches, injects,
 * patches, or starts packet capture.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectBinaryBuffer } from "../server/security/binary.mjs";
import { detectSecurityTools } from "../server/security/detect.mjs";
import { createProcessInspector } from "../server/security/processes.mjs";
import { createNetworkSnapshot } from "../server/security/network.mjs";
import {
  defaultNetworkRunner,
  defaultProcessRunner,
} from "../server/security/windows-runners.mjs";

const targets = [
  "C:\\Windows\\System32\\notepad.exe",
  "C:\\Windows\\System32\\write.exe",
];

async function main() {
  if (process.platform !== "win32") {
    console.log(
      JSON.stringify(
        {
          skipped: true,
          reason: "Windows read-only acceptance requires win32",
          platform: process.platform,
        },
        null,
        2,
      ),
    );
    return;
  }
  let file = null;
  for (const candidate of targets) {
    try {
      await fs.access(candidate);
      file = candidate;
      break;
    } catch {
      /* try next */
    }
  }
  if (!file) {
    console.log(JSON.stringify({ ok: false, error: "No harmless Windows binary found" }));
    process.exitCode = 1;
    return;
  }
  const bytes = await fs.readFile(file);
  const inspect = inspectBinaryBuffer(bytes, { fileName: path.basename(file) });
  const processes = createProcessInspector({ runner: defaultProcessRunner });
  const network = createNetworkSnapshot({ runner: defaultNetworkRunner });
  const proc = await processes.inspect({ name: path.basename(file) }).catch((e) => ({
    error: e.message,
  }));
  const net = await network.snapshot().catch((e) => ({ error: e.message }));
  const report = {
    skipped: false,
    file,
    discovered: true,
    sha256: inspect.observed?.sha256 || null,
    format: inspect.observed?.format || null,
    architecture: inspect.observed?.architecture || null,
    sectionCount: inspect.observed?.sections?.length || 0,
    importDlls: (inspect.observed?.imports || []).map((i) => i.dll),
    signature: {
      authenticodeDirectoryPresent:
        inspect.observed?.authenticodeDirectoryPresent ?? null,
      signed: inspect.observed?.signed ?? null,
    },
    executed: inspect.observed?.executed,
    process: proc.observed
      ? { pid: proc.observed.pid, path: proc.observed.path, injected: proc.observed.injected }
      : { error: proc.error },
    network: net.observed
      ? {
          interfaceCount: net.observed.interfaces?.length,
          listeningTcp: net.observed.listeningTcp?.length,
          tcpConnections: net.observed.tcpConnections?.length,
        }
      : { error: net.error },
    optionalTools: detectSecurityTools(),
    captureStarted: false,
    hostname: os.hostname(),
  };
  console.log(JSON.stringify(report, null, 2));
}

await main();
