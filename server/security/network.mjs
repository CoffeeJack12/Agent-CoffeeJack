/**
 * Read-only network snapshot. Does not classify remotes as malicious.
 */

import { securityResult } from "./evidence.mjs";

export function createNetworkSnapshot({ runner } = {}) {
  return {
    async snapshot() {
      if (typeof runner !== "function") {
        if (process.platform !== "win32") {
          return securityResult({
            tool: "security_network_snapshot",
            available: false,
            error: "Network snapshot currently supports Windows.",
            observed: { platform: process.platform },
          });
        }
        return securityResult({
          tool: "security_network_snapshot",
          available: false,
          error: "Network snapshot runner is not configured.",
          observed: { platform: process.platform },
        });
      }
      const raw = await runner();
      const connections = (raw.connections || []).slice(0, 200).map((c) => ({
        protocol: c.protocol,
        localAddress: c.localAddress,
        localPort: c.localPort,
        remoteAddress: c.remoteAddress || null,
        remotePort: c.remotePort || null,
        state: c.state || null,
        pid: c.pid ?? null,
        processName: c.processName || null,
      }));
      return securityResult({
        tool: "security_network_snapshot",
        available: true,
        observed: {
          interfaces: (raw.interfaces || []).slice(0, 32),
          listeningTcp: connections.filter(
            (c) => /tcp/i.test(c.protocol || "") && /listen/i.test(c.state || ""),
          ),
          tcpConnections: connections.filter((c) => /tcp/i.test(c.protocol || "")),
          udpEndpoints: connections.filter((c) => /udp/i.test(c.protocol || "")),
          connections,
        },
        unverified: [
          "Remote endpoints are listed as observed addresses only. Malice is not inferred.",
        ],
      });
    },
  };
}
