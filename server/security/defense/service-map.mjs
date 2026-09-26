/**
 * Local service mapping from listening ports. No exploit execution.
 */

import { securityResult } from "../evidence.mjs";

export function mapServices({
  listeners = [],
  processes = [],
  tls = [],
  banners = [],
} = {}) {
  const procByPid = new Map(
    (processes || []).map((p) => [Number(p.pid), p]),
  );
  const tlsByPort = new Map(
    (tls || []).map((t) => [Number(t.port), t]),
  );
  const bannerByPort = new Map(
    (banners || []).map((b) => [Number(b.port), String(b.banner || "").slice(0, 180)]),
  );
  const services = (listeners || []).slice(0, 200).map((l) => {
    const pid = l.pid ?? l.owningPid ?? null;
    const proc = pid != null ? procByPid.get(Number(pid)) : null;
    const port = Number(l.localPort ?? l.port);
    return {
      protocol: l.protocol || "tcp",
      address: l.localAddress || l.address || null,
      port,
      state: l.state || "Listen",
      pid,
      processName: proc?.name || l.processName || null,
      processPath: proc?.path || l.path || null,
      identification: identifyService(l, bannerByPort.get(port), tlsByPort.get(port)),
      tls: tlsByPort.get(port)
        ? {
            protocol: tlsByPort.get(port).protocol || null,
            expired: Boolean(tlsByPort.get(port).expired),
          }
        : null,
      banner: bannerByPort.get(port) || null,
    };
  });
  return securityResult({
    tool: "security_service_map",
    observed: {
      count: services.length,
      services,
    },
    unverified: [
      "Banners and TLS metadata are identification hints, not proof of a product or a vulnerability. No exploit was executed.",
    ],
  });
}

function identifyService(listener, banner, tls) {
  const port = Number(listener.localPort ?? listener.port);
  const known = {
    22: "ssh",
    25: "smtp",
    53: "dns",
    80: "http",
    110: "pop3",
    143: "imap",
    443: "https",
    445: "smb",
    3389: "rdp",
    5432: "postgres",
    3306: "mysql",
  };
  if (tls) return known[port] === "http" ? "https" : known[port] || "tls";
  if (banner && /ssh/i.test(banner)) return "ssh";
  if (banner && /http\/1/i.test(banner)) return "http";
  return known[port] || "unknown";
}
