/**
 * Windows-focused read-only process inspection.
 * No injection. No in-process code execution. No guessing among same-name processes.
 */

import { securityResult } from "./evidence.mjs";

export function createProcessInspector({ runner, hashesOf } = {}) {
  return {
    async inspect({ pid = null, name = null } = {}) {
      if (typeof runner !== "function") {
        if (process.platform !== "win32") {
          return securityResult({
            tool: "security_process_inspect",
            available: false,
            error: "Process inspection currently supports Windows.",
            observed: { platform: process.platform },
          });
        }
        return securityResult({
          tool: "security_process_inspect",
          available: false,
          error: "Process inspector runner is not configured.",
          observed: { platform: process.platform },
        });
      }
      const raw = await runner({ pid, name });
      const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
      if (name && !pid) {
        const exact = rows.filter(
          (r) =>
            String(r.name || r.processName || "").toLowerCase() ===
            String(name).toLowerCase(),
        );
        if (exact.length > 1) {
          return securityResult({
            tool: "security_process_inspect",
            available: true,
            error:
              "Multiple processes share that executable name. Select by PID.",
            observed: {
              name,
              candidates: exact.map((r) => ({
                pid: r.pid,
                path: r.path || r.executablePath || null,
              })),
            },
            unverified: ["No process was selected."],
          });
        }
      }
      const proc = rows[0];
      if (!proc) {
        return securityResult({
          tool: "security_process_inspect",
          available: true,
          error: "No matching process.",
          observed: { pid, name },
        });
      }
      const modules = (proc.modules || []).slice(0, 80).map((m) => ({
        name: m.name,
        path: m.path,
        sha256:
          m.sha256 ||
          (typeof hashesOf === "function" && m.bytes
            ? hashesOf(m.bytes).sha256
            : null),
      }));
      return securityResult({
        tool: "security_process_inspect",
        available: true,
        observed: {
          pid: proc.pid,
          name: proc.name || proc.processName,
          path: proc.path || proc.executablePath || null,
          parentPid: proc.parentPid ?? proc.ppid ?? null,
          commandLine: proc.commandLine ?? null,
          architecture: proc.architecture || null,
          startTime: proc.startTime || null,
          memoryBytes: proc.memoryBytes ?? proc.workingSet ?? null,
          signatureStatus: proc.signatureStatus || null,
          modules,
          ports: (proc.ports || []).slice(0, 40),
          injected: false,
          executedInProcess: false,
        },
        unverified: [
          "Module hashes and signature status are reported only when the runner supplied them.",
        ],
      });
    },
  };
}
