/**
 * Bounded TCP/UDP reachability tests. Distinguishes local vs remote failures when possible.
 */

import net from "node:net";
import { securityResult } from "../evidence.mjs";

export function defaultTcpConnect({ host, port, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => {
      socket.end();
      resolve({ reachable: true });
    });
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => {
      socket.destroy();
      reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    });
    socket.once("error", reject);
  });
}

export const MAX_PORTS = 32;
export const DEFAULT_TIMEOUT_MS = 2000;

export function classifyConnectFailure(error = {}) {
  const code = String(error.code || error.errno || "").toUpperCase();
  const message = String(error.message || "");
  if (["EADDRNOTAVAIL", "EACCES", "EPERM"].includes(code)) return "local";
  if (["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED"].includes(code)) return "remote";
  if (code === "ETIMEDOUT" || /timeout/i.test(message)) return "unverified";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  return "unverified";
}

export function expandPortRange(ports) {
  const out = [];
  const list = Array.isArray(ports) ? ports : [ports];
  for (const item of list) {
    if (out.length >= MAX_PORTS) break;
    if (item && typeof item === "object" && item.from != null) {
      const from = Number(item.from);
      const to = Number(item.to ?? item.from);
      for (let p = from; p <= to && out.length < MAX_PORTS; p++) {
        if (Number.isInteger(p) && p >= 1 && p <= 65535) out.push(p);
      }
      continue;
    }
    const n = Number(item);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) out.push(n);
  }
  return [...new Set(out)].slice(0, MAX_PORTS);
}

export async function testOnePort({
  host,
  port,
  protocol = "tcp",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  connect,
} = {}) {
  const proto = String(protocol || "tcp").toLowerCase();
  const start = Date.now();
  const exec = typeof connect === "function" ? connect : defaultTcpConnect;
  if (proto !== "tcp" && typeof connect !== "function") {
    return {
      host,
      port,
      protocol: proto,
      reachable: false,
      latencyMs: 0,
      timeout: false,
      reason: "UDP tests require an explicit connector.",
      failureClass: "unverified",
    };
  }
  try {
    const raced = await Promise.race([
      exec({ host, port, protocol: proto, timeoutMs }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
          timeoutMs,
        ),
      ),
    ]);
    return {
      host,
      port,
      protocol: proto,
      reachable: raced?.reachable !== false,
      latencyMs: Date.now() - start,
      timeout: false,
      reason: null,
      failureClass: null,
    };
  } catch (error) {
    const failureClass = classifyConnectFailure(error);
    return {
      host,
      port,
      protocol: proto,
      reachable: false,
      latencyMs: Date.now() - start,
      timeout: String(error.code || "") === "ETIMEDOUT" || /timeout/i.test(error.message || ""),
      reason: error.code || error.message || "connect failed",
      failureClass,
    };
  }
}

export async function testPorts({
  host,
  ports,
  protocol = "tcp",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  connect,
} = {}) {
  const expanded = expandPortRange(ports);
  const results = [];
  for (const port of expanded) {
    results.push(await testOnePort({ host, port, protocol, timeoutMs, connect }));
  }
  const timeouts = results.filter((r) => r.timeout);
  return securityResult({
    tool: "security_port_test",
    observed: {
      host,
      protocol,
      count: results.length,
      truncated: (Array.isArray(ports) ? ports.length : 1) > 0 && expanded.length >= MAX_PORTS,
      results,
    },
    mismatch: results.filter((r) => r.reachable === false).map(
      (r) => `${r.protocol}/${r.port} not reachable (${r.reason})`,
    ),
    possibleCause: timeouts.length
      ? [
          "Timeout can be a remote drop, a local filter, or an unused service. It is not classified as remote without more evidence.",
        ]
      : results.some((r) => r.failureClass === "remote")
        ? ["A refused connection indicates a reachable host that is not accepting the port."]
        : [],
    recommendedRemediation: results.some((r) => !r.reachable)
      ? [
          "Confirm the service is listening, then compare the matching firewall rule for this profile and direction.",
        ]
      : [],
    unverified: [
      "UDP reachability is best-effort and absence of a reply is not proof the port is closed.",
    ],
  });
}
