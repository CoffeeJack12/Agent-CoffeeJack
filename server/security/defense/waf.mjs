/**
 * Benign WAF validation against Owner-authorized targets only.
 * No evasion, encoding tricks, or exploit payloads.
 */

import { securityResult } from "../evidence.mjs";
import { assertAuthorizedTarget, looksLikeEvasion } from "./authorized.mjs";

export const BENIGN_WAF_TESTS = Object.freeze([
  { id: "get-root", method: "GET", path: "/" },
  { id: "get-health", method: "GET", path: "/health" },
  { id: "trailing-slash", method: "GET", path: "/health/" },
  {
    id: "extra-header",
    method: "GET",
    path: "/",
    headers: { "x-coffeejack-audit": "benign" },
  },
  { id: "head-root", method: "HEAD", path: "/" },
  { id: "options-root", method: "OPTIONS", path: "/" },
  {
    id: "small-body",
    method: "POST",
    path: "/",
    body: "hello",
    headers: { "content-type": "text/plain" },
  },
  {
    id: "body-size",
    method: "POST",
    path: "/",
    body: "A".repeat(8000),
    headers: { "content-type": "text/plain" },
  },
  { id: "rate-limit", method: "GET", path: "/health", repeat: 5 },
]);

export async function runWafTests({
  target,
  allowlist = [],
  http,
  tests = BENIGN_WAF_TESTS,
} = {}) {
  const auth = assertAuthorizedTarget(target, allowlist);
  if (!auth.ok) {
    return securityResult({
      tool: "security_waf_test",
      available: true,
      error: auth.error,
      observed: { target, authorized: false },
    });
  }
  if (typeof http !== "function") {
    return securityResult({
      tool: "security_waf_test",
      available: false,
      error: "HTTP adapter is not configured.",
      observed: { target, authorized: true },
    });
  }
  const selected = (tests || []).slice(0, 12);
  for (const spec of selected) {
    if (looksLikeEvasion(`${spec.method} ${spec.path} ${JSON.stringify(spec.headers || {})}`)) {
      return securityResult({
        tool: "security_waf_test",
        error: "Refusing a request that looks like evasion or an exploit payload.",
        observed: { target, refused: spec.id },
      });
    }
  }
  const results = [];
  for (const spec of selected) {
    const repeat = Math.min(8, Math.max(1, Number(spec.repeat) || 1));
    const statuses = [];
    for (let i = 0; i < repeat; i++) {
      const response = await http({
        url: joinUrl(auth.parsed, spec.path),
        method: spec.method,
        headers: spec.headers || {},
        body: spec.body || null,
      });
      statuses.push({
        status: response.status,
        bytes: Number(response.bytes ?? String(response.body || "").length),
      });
    }
    results.push({
      id: spec.id,
      method: spec.method,
      path: spec.path,
      statuses,
      status: statuses.at(-1)?.status ?? null,
    });
  }
  return securityResult({
    tool: "security_waf_test",
    observed: {
      target: auth.parsed.host,
      authorized: true,
      evasion: false,
      results,
    },
    expected: ["Benign catalog requests only; compare status codes across variations"],
    mismatch: [],
    recommendedRemediation: [
      "Use status-code comparison across these benign variants. Do not add exploit payloads.",
    ],
    unverified: [
      "A 403 or 429 is an observed control response, not a bypass result.",
    ],
  });
}

function joinUrl(parsed, path) {
  const protocol = parsed.protocol || "https";
  const port = parsed.port ? `:${parsed.port}` : "";
  return `${protocol}://${parsed.host}${port}${path}`;
}
