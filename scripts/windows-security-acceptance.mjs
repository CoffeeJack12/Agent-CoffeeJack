/**
 * Read-only Windows acceptance for deterministic binary inspection.
 * Inspects a harmless signed Microsoft binary. Never attaches, injects,
 * patches, starts packet capture, or executes the target.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSecurityToolkit } from "../server/security/index.mjs";
import {
  classifySecurityIntent,
  extractSecurityFileTarget,
} from "../server/security/index.mjs";
import {
  filterToolsForTurn,
  resolveTurnContext,
} from "../server/conversation-intent.mjs";
import { definitions } from "../server/tools.mjs";

const TARGET = "C:\\Windows\\System32\\notepad.exe";
const REQUEST = `Analyze ${TARGET}`;
const FALLBACKS = [
  TARGET,
  "C:\\Windows\\System32\\write.exe",
];

function toolNames(defs) {
  return defs.map((d) => d.function?.name || d.name);
}

async function main() {
  const extracted = extractSecurityFileTarget(REQUEST);
  const intent = classifySecurityIntent(REQUEST);
  const turn = resolveTurnContext(REQUEST, {
    history: [
      { role: "user", content: "Show network connections" },
      {
        role: "assistant",
        content: "chrome.exe has established TCP connections.",
      },
    ],
    previousSecurityTarget: { tool: "security_network_snapshot" },
  });
  const offered = toolNames(filterToolsForTurn(definitions, turn));
  const routing = {
    request: REQUEST,
    classifiedIntent: intent?.tool || null,
    exactPath: extracted?.path || null,
    pathPreserved: extracted?.path === TARGET,
    offeredTools: offered,
    processInspectOffered: offered.includes("security_process_inspect"),
    networkSnapshotOffered: offered.includes("security_network_snapshot"),
    staleNetworkInherited: /chrome\.exe|TCP/.test(
      `${turn.threadContext || ""}${turn.snapshot?.lastAssistant || ""}`,
    ),
  };

  if (process.platform !== "win32") {
    console.log(
      JSON.stringify(
        {
          skipped: true,
          reason: "Windows live binary acceptance requires win32",
          platform: process.platform,
          routing,
          routingOk:
            routing.classifiedIntent === "security_binary_inspect" &&
            routing.exactPath === TARGET &&
            routing.pathPreserved &&
            offered.includes("security_binary_inspect") &&
            !routing.processInspectOffered &&
            !routing.networkSnapshotOffered &&
            !routing.staleNetworkInherited,
        },
        null,
        2,
      ),
    );
    return;
  }

  let file = null;
  for (const candidate of FALLBACKS) {
    try {
      await fs.access(candidate);
      file = candidate;
      break;
    } catch {
      /* try next */
    }
  }
  if (!file) {
    console.log(
      JSON.stringify({
        ok: false,
        error: "No harmless Windows binary found",
        routing,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const invoked = [];
  const kit = createSecurityToolkit({
    workspace: path.dirname(file),
    dataDirectory: path.join(os.tmpdir(), "cj-win-sec-accept"),
    user: { id: "owner", role: "owner", status: "active" },
    adapters: {
      processRunner: async () => {
        invoked.push("security_process_inspect");
        throw new Error("process inspector must not run during binary acceptance");
      },
      networkRunner: async () => {
        invoked.push("security_network_snapshot");
        throw new Error("network snapshot must not run during binary acceptance");
      },
    },
  });
  invoked.push("security_binary_inspect");
  const inspect = await kit.execute("security_binary_inspect", { path: file });
  const report = {
    skipped: false,
    ok:
      routing.classifiedIntent === "security_binary_inspect" &&
      routing.exactPath === TARGET &&
      offered.includes("security_binary_inspect") &&
      !routing.processInspectOffered &&
      !routing.networkSnapshotOffered &&
      invoked.includes("security_binary_inspect") &&
      !invoked.includes("security_process_inspect") &&
      !invoked.includes("security_network_snapshot") &&
      inspect.observed?.executed === false &&
      Boolean(inspect.observed?.sha256) &&
      Boolean(inspect.observed?.architecture || inspect.observed?.format) &&
      Array.isArray(inspect.observed?.sections) &&
      Array.isArray(inspect.observed?.imports),
    file,
    request: REQUEST,
    classifiedIntent: routing.classifiedIntent,
    exactPathPreserved: routing.pathPreserved,
    invoked,
    processInspectInvoked: invoked.includes("security_process_inspect"),
    networkSnapshotInvoked: invoked.includes("security_network_snapshot"),
    executed: inspect.observed?.executed,
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
    staleNetworkInherited: routing.staleNetworkInherited,
    hostname: os.hostname(),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

await main();
