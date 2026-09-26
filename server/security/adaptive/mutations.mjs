/**
 * Bounded, recorded test variations for authorized lab validation.
 * No stealth, persistence, credential theft, or exploit payloads.
 */

import { createHash } from "node:crypto";

export const MUTATION_CATEGORIES = Object.freeze([
  "http_method",
  "header_order",
  "duplicate_header",
  "header_case",
  "url_encoding",
  "path_normalization",
  "query_order",
  "content_type",
  "body_size",
  "http_version",
  "tcp_port",
  "ipv4_ipv6",
  "dns_vs_ip",
  "tls_vs_plaintext",
  "sni",
  "mtu",
  "safe_fuzz",
]);

const UNSAFE =
  /(?:<script|union\s+select|'\s*or\s+'|\$\{|cmd=|\/etc\/passwd|mimikatz|meterpreter|reverse\s+shell|\bexploit(?:\s+chain)?\b|\bstealth\b|\bpersistence\b|keylog|credential\s*theft)/i;

export function looksLikeExploitPayload(value = "") {
  return UNSAFE.test(String(value || ""));
}

export function mutationId(parts) {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

function headerEntries(headers = {}) {
  return Object.entries(headers || {}).map(([name, value]) => ({
    name,
    value: String(value ?? ""),
  }));
}

function headersFromEntries(entries) {
  const out = {};
  for (const row of entries) out[row.name] = row.value;
  return out;
}

export function baselineRequest(input = {}, target = {}) {
  const path = String(input.path || "/");
  const method = String(input.method || "GET").toUpperCase();
  const headers = { ...(input.headers || {}) };
  if (!headers.accept) headers.accept = "text/plain";
  return {
    method,
    path,
    query: input.query && typeof input.query === "object" ? { ...input.query } : {},
    headers,
    body: input.body ?? null,
    bodyKind: input.bodyKind || (input.body ? "text" : "none"),
    contentType: headers["content-type"] || headers["Content-Type"] || null,
    httpVersion: input.httpVersion || "1.1",
    hostKind: input.hostKind || "registered_name",
    ipVersion: input.ipVersion || "ipv4",
    tls: input.tls ?? (target.protocols || []).includes("https"),
    sni: input.sni || target.host || null,
    port: input.port || target.ports?.[0] || (input.tls ? 443 : 80),
    protocol: input.protocol || (input.tls ? "https" : "http"),
    mtu: input.mtu || null,
  };
}

function recordCase({
  targetId,
  family,
  category,
  request,
  parentId = null,
  note = null,
}) {
  if (looksLikeExploitPayload(JSON.stringify(request))) return null;
  return {
    case_id: mutationId({ targetId, family, category, request }),
    target_id: targetId,
    family,
    category,
    request: { ...request, headers: { ...request.headers }, query: { ...request.query } },
    parent_id: parentId,
    note,
    recorded: true,
  };
}

function pathVariants(basePath) {
  const clean = basePath.startsWith("/") ? basePath : `/${basePath}`;
  const trimmed = clean.replace(/\/+$/, "") || "/";
  const leaf = trimmed === "/" ? "" : trimmed;
  return [
    { path: `${trimmed}/`, note: "trailing slash" },
    { path: `/.${trimmed}`, note: "/. prefix" },
    { path: `/${trimmed}`.replace("//", "//"), note: "double-slash keep" },
    { path: `//${trimmed.replace(/^\//, "")}`, note: "double slash" },
    { path: trimmed.replace(/\//g, "/./"), note: "dot-segment insertion" },
    { path: leaf ? `${leaf}/../${leaf.replace(/^\//, "")}` : "/./", note: "same-path parent segment" },
    { path: encodeURI(trimmed), note: "URI encode" },
    { path: trimmed.replace(/\//g, "%2f"), note: "slash percent-encoding" },
    { path: trimmed.toUpperCase() === trimmed ? trimmed.toLowerCase() : trimmed.toUpperCase(), note: "path case" },
  ].filter((row, index, all) => row.path && all.findIndex((x) => x.path === row.path) === index);
}

export function generateHttpMutations(baseline, { target, budget = 25, families = null } = {}) {
  const targetId = target.target_id;
  const request = baselineRequest(baseline, target);
  const want = families ? new Set(families) : null;
  const out = [];

  const push = (row) => {
    if (!row) return;
    if (want && !want.has(row.category) && !want.has(row.family)) return;
    if (out.length >= budget) return;
    if (out.some((item) => item.case_id === row.case_id)) return;
    out.push(row);
  };

  for (const method of ["GET", "POST", "HEAD", "OPTIONS", "PUT"]) {
    if (method === request.method) continue;
    push(
      recordCase({
        targetId,
        family: "http_method",
        category: "http_method",
        request: { ...request, method, body: method === "GET" || method === "HEAD" ? null : request.body },
        note: `method ${request.method} → ${method}`,
      }),
    );
  }

  const entries = headerEntries(request.headers);
  if (entries.length > 1) {
    const reversed = [...entries].reverse();
    push(
      recordCase({
        targetId,
        family: "headers",
        category: "header_order",
        request: { ...request, headers: headersFromEntries(reversed) },
        note: "harmless header reordering",
      }),
    );
  }
  push(
    recordCase({
      targetId,
      family: "headers",
      category: "duplicate_header",
      request: {
        ...request,
        headers: { ...request.headers, "x-coffeejack-lab": "one", "X-Coffeejack-Lab": "two" },
      },
      note: "duplicate benign header",
    }),
  );
  const cased = {};
  for (const [name, value] of Object.entries(request.headers)) {
    cased[name.toUpperCase()] = value;
  }
  push(
    recordCase({
      targetId,
      family: "headers",
      category: "header_case",
      request: { ...request, headers: cased },
      note: "header capitalization",
    }),
  );

  for (const variant of pathVariants(request.path)) {
    push(
      recordCase({
        targetId,
        family: "path_normalization",
        category: variant.note.includes("percent") || variant.note.includes("URI")
          ? "url_encoding"
          : "path_normalization",
        request: { ...request, path: variant.path },
        note: variant.note,
      }),
    );
  }

  if (Object.keys(request.query || {}).length >= 2) {
    const keys = Object.keys(request.query).reverse();
    const reordered = {};
    for (const key of keys) reordered[key] = request.query[key];
    push(
      recordCase({
        targetId,
        family: "query",
        category: "query_order",
        request: { ...request, query: reordered },
        note: "query parameter order",
      }),
    );
  }

  for (const type of ["application/json", "application/x-www-form-urlencoded", "text/plain"]) {
    if (type === request.contentType) continue;
    push(
      recordCase({
        targetId,
        family: "content_type",
        category: "content_type",
        request: {
          ...request,
          method: request.method === "GET" ? "POST" : request.method,
          contentType: type,
          headers: { ...request.headers, "content-type": type },
          body: type === "application/json" ? "{}" : "a=1",
          bodyKind: type === "application/json" ? "json" : "form",
        },
        note: `content-type ${type}`,
      }),
    );
  }

  for (const size of [0, 1, 1024, 8192]) {
    push(
      recordCase({
        targetId,
        family: "body_size",
        category: "body_size",
        request: {
          ...request,
          method: "POST",
          bodyKind: "text",
          body: "A".repeat(size),
          headers: { ...request.headers, "content-type": "text/plain" },
          contentType: "text/plain",
        },
        note: `body size ${size}`,
      }),
    );
  }

  for (const version of ["1.0", "1.1"]) {
    if (version === request.httpVersion) continue;
    push(
      recordCase({
        targetId,
        family: "http_version",
        category: "http_version",
        request: { ...request, httpVersion: version },
        note: `HTTP/${version}`,
      }),
    );
  }

  return out.slice(0, budget);
}

export function generateNetworkMutations(baseline, { target, budget = 25 } = {}) {
  const request = baselineRequest(baseline, target);
  const targetId = target.target_id;
  const out = [];
  const ports = (target.ports || []).filter((p) => p !== request.port).slice(0, 6);
  for (const port of ports) {
    const row = recordCase({
      targetId,
      family: "network",
      category: "tcp_port",
      request: { ...request, port, protocol: "tcp" },
      note: `configured test port ${port}`,
    });
    if (row) out.push(row);
  }
  out.push(
    recordCase({
      targetId,
      family: "network",
      category: "ipv4_ipv6",
      request: { ...request, ipVersion: request.ipVersion === "ipv6" ? "ipv4" : "ipv6" },
      note: "IPv4 vs IPv6",
    }),
  );
  out.push(
    recordCase({
      targetId,
      family: "network",
      category: "dns_vs_ip",
      request: {
        ...request,
        hostKind: request.hostKind === "direct_ip" ? "registered_name" : "direct_ip",
      },
      note: "DNS name vs configured IP",
    }),
  );
  if ((target.protocols || []).includes("https") || (target.protocols || []).includes("http")) {
    out.push(
      recordCase({
        targetId,
        family: "network",
        category: "tls_vs_plaintext",
        request: { ...request, tls: !request.tls, protocol: request.tls ? "http" : "https" },
        note: "TLS vs plaintext",
      }),
    );
  }
  if (target.host) {
    out.push(
      recordCase({
        targetId,
        family: "network",
        category: "sni",
        request: { ...request, tls: true, sni: target.host, protocol: "https" },
        note: "configured lab SNI",
      }),
    );
    out.push(
      recordCase({
        targetId,
        family: "network",
        category: "sni",
        request: { ...request, tls: true, sni: `lab.${target.host}`, protocol: "https" },
        note: "alternate configured-family SNI",
      }),
    );
  }
  out.push(
    recordCase({
      targetId,
      family: "network",
      category: "mtu",
      request: { ...request, mtu: 1280, protocol: "tcp" },
      note: "OS-supported MTU diagnostic (1280)",
    }),
  );
  return out.filter(Boolean).slice(0, budget);
}

export function generateRelatedFamily(seed, { target, budget = 8 } = {}) {
  const category = seed.category || seed.family;
  if (category === "path_normalization" || category === "url_encoding") {
    return generateHttpMutations(seed.request, {
      target,
      budget,
      families: ["path_normalization", "url_encoding"],
    }).filter((row) => row.case_id !== seed.case_id);
  }
  if (["header_order", "duplicate_header", "header_case"].includes(category)) {
    return generateHttpMutations(seed.request, {
      target,
      budget,
      families: ["headers", "header_order", "duplicate_header", "header_case"],
    }).filter((row) => row.case_id !== seed.case_id);
  }
  if (category === "http_method") {
    return generateHttpMutations(seed.request, {
      target,
      budget,
      families: ["http_method"],
    }).filter((row) => row.case_id !== seed.case_id);
  }
  if (category === "content_type") {
    return generateHttpMutations(seed.request, {
      target,
      budget,
      families: ["content_type"],
    }).filter((row) => row.case_id !== seed.case_id);
  }
  return generateHttpMutations(seed.request, { target, budget }).filter(
    (row) => row.case_id !== seed.case_id && row.category === category,
  );
}

export function generateSafeFuzzCases(baseline, { target, budget = 10 } = {}) {
  const request = baselineRequest(baseline, target);
  const targetId = target.target_id;
  const specs = [
    {
      note: "truncated request line",
      request: { ...request, path: request.path.slice(0, Math.max(1, request.path.length - 1)), fuzz: "truncated_line" },
    },
    {
      note: "missing header colon (benign malformed)",
      request: { ...request, headers: { ...request.headers, "x-lab-malformed": "no-colon-test" }, fuzz: "header_token" },
    },
    {
      note: "empty header value",
      request: { ...request, headers: { ...request.headers, "x-lab-empty": "" }, fuzz: "empty_header" },
    },
    {
      note: "HTTP/0.9 style",
      request: { ...request, httpVersion: "0.9", fuzz: "http09" },
    },
    {
      note: "content-length mismatch (benign)",
      request: {
        ...request,
        method: "POST",
        body: "hello",
        headers: { ...request.headers, "content-type": "text/plain", "content-length": "1" },
        fuzz: "cl_mismatch",
      },
    },
    {
      note: "boundary body size 64KiB",
      request: {
        ...request,
        method: "POST",
        body: "B".repeat(64 * 1024),
        bodyKind: "text",
        headers: { ...request.headers, "content-type": "text/plain" },
        fuzz: "boundary_64k",
      },
    },
  ];
  return specs
    .map((spec) =>
      recordCase({
        targetId,
        family: "safe_fuzz",
        category: "safe_fuzz",
        request: spec.request,
        note: spec.note,
      }),
    )
    .filter(Boolean)
    .slice(0, budget);
}
