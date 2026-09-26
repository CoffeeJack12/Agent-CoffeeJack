/**
 * Optional local telemetry adapters.
 * Never fabricate missing firewall / WAF / IDS evidence.
 */

function emptyCorrelation(reason) {
  return {
    available: false,
    reason,
    firewall: null,
    waf: null,
    ids: null,
    proxy: null,
    fabricated: false,
  };
}

export function parseWindowsFirewallLog(text = "") {
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    if (line.startsWith("#") || line.startsWith("time")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 8) continue;
    rows.push({
      adapter: "windows_firewall",
      timestamp: `${parts[0]} ${parts[1]}`,
      action: String(parts[2] || "").toUpperCase(),
      protocol: parts[3] || null,
      src: parts[4] || null,
      dst: parts[5] || null,
      srcPort: parts[6] || null,
      dstPort: parts[7] || null,
      size: parts[8] || null,
    });
  }
  return { adapter: "windows_firewall", available: rows.length > 0, rows };
}

export function parseSuricataEve(text = "") {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      rows.push({
        adapter: "suricata",
        timestamp: evt.timestamp || null,
        eventType: evt.event_type || null,
        action: evt.alert?.action || evt.drop || null,
        signature: evt.alert?.signature || null,
        destIp: evt.dest_ip || null,
        destPort: evt.dest_port || null,
        http: evt.http
          ? { method: evt.http.http_method, path: evt.http.url, status: evt.http.status }
          : null,
      });
    } catch {
      /* skip non-JSON lines; do not invent events */
    }
  }
  return { adapter: "suricata", available: rows.length > 0, rows };
}

export function parseZeekConn(text = "") {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\t|\s+/);
    if (parts.length < 7) continue;
    rows.push({
      adapter: "zeek",
      timestamp: parts[0],
      uid: parts[1],
      src: parts[2],
      srcPort: parts[3],
      dst: parts[4],
      dstPort: parts[5],
      protocol: parts[6],
      service: parts[7] || null,
    });
  }
  return { adapter: "zeek", available: rows.length > 0, rows };
}

export function parseModSecurityLog(text = "") {
  const rows = [];
  const blocks = /--[a-f0-9]+-A--/i.test(text)
    ? String(text || "").split(/--[a-f0-9]+-A--/i).filter(Boolean)
    : [];
  if (!blocks.length) {
    for (const line of String(text).split(/\r?\n/)) {
      if (!/ModSecurity|coraza/i.test(line)) continue;
      const id = /id\s*"?(\d+)"?/i.exec(line);
      rows.push({
        adapter: "modsecurity",
        action: /denied|deny|block/i.test(line) ? "block" : /pass|allow/i.test(line) ? "allow" : null,
        ruleId: id?.[1] || null,
        message: line.slice(0, 240),
      });
    }
    return { adapter: "modsecurity", available: rows.length > 0, rows };
  }
  for (const block of blocks) {
    const action = /deny|block/i.test(block) ? "block" : /pass|allow/i.test(block) ? "allow" : null;
    const path = /\]\s+[A-Z]+\s+(\S+)/.exec(block);
    rows.push({
      adapter: "modsecurity",
      action,
      path: path?.[1] || null,
      message: block.slice(0, 240),
    });
  }
  return { adapter: "modsecurity", available: rows.length > 0, rows };
}

export function parseReverseProxyAccess(text = "") {
  const rows = [];
  const re =
    /(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([A-Z]+)\s+(\S+)\s+HTTP\/[\d.]+"\s+(\d{3})\s+(\d+|-)/;
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    rows.push({
      adapter: "reverse_proxy",
      src: m[1],
      timestamp: m[2],
      method: m[3],
      path: m[4],
      status: Number(m[5]),
      bytes: m[6] === "-" ? null : Number(m[6]),
    });
  }
  return { adapter: "reverse_proxy", available: rows.length > 0, rows };
}

export function correlateTelemetry({
  request = {},
  windowsFirewall = "",
  suricata = "",
  zeek = "",
  modsecurity = "",
  proxy = "",
} = {}) {
  const sources = {
    firewall: windowsFirewall ? parseWindowsFirewallLog(windowsFirewall) : { available: false, rows: [] },
    ids: suricata ? parseSuricataEve(suricata) : { available: false, rows: [] },
    zeek: zeek ? parseZeekConn(zeek) : { available: false, rows: [] },
    waf: modsecurity ? parseModSecurityLog(modsecurity) : { available: false, rows: [] },
    proxy: proxy ? parseReverseProxyAccess(proxy) : { available: false, rows: [] },
  };
  const any = Object.values(sources).some((s) => s.available);
  if (!any) return emptyCorrelation("No local telemetry adapters supplied evidence.");

  const dest = request.host || request.destination || null;
  const port = request.port != null ? String(request.port) : null;
  const pathName = request.path || null;

  const pick = (parsed, predicate) => {
    if (!parsed.available) return { available: false, fabricated: false };
    const matches = parsed.rows.filter(predicate);
    if (!matches.length) return { available: true, matched: false, fabricated: false, adapter: parsed.adapter };
    return {
      available: true,
      matched: true,
      fabricated: false,
      adapter: parsed.adapter,
      events: matches.slice(0, 8),
    };
  };

  return {
    available: true,
    fabricated: false,
    firewall: pick(
      sources.firewall,
      (row) => (!dest || row.dst === dest) && (!port || String(row.dstPort) === port),
    ),
    waf: pick(
      sources.waf,
      (row) => !pathName || !row.path || row.path === pathName || String(row.message || "").includes(pathName),
    ),
    ids: pick(
      sources.ids,
      (row) =>
        (!dest || row.destIp === dest) &&
        (!port || String(row.destPort) === String(port)) &&
        (!pathName || !row.http?.path || row.http.path === pathName),
    ),
    zeek: pick(
      sources.zeek,
      (row) => (!dest || row.dst === dest) && (!port || String(row.dstPort) === port),
    ),
    proxy: pick(
      sources.proxy,
      (row) =>
        (!pathName || row.path === pathName) &&
        (!request.method || row.method === request.method),
    ),
  };
}
