/**
 * Classify observed lab outcomes. Never invent missing telemetry.
 */

export const OBSERVED_DECISIONS = Object.freeze([
  "allow",
  "block",
  "throttle",
  "error",
  "timeout",
  "crash",
]);

export function classifyObserved(response = {}) {
  if (response.crash === true || response.processCrashed === true) return "crash";
  if (response.timedOut === true || response.code === "ETIMEDOUT") return "timeout";
  if (response.code === "ECONNRESET" && response.afterMalformed) return "crash";
  if (["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH"].includes(response.code)) {
    return response.expectedReset ? "block" : "block";
  }
  const status = Number(response.status || response.statusCode || 0);
  if (status === 429) return "throttle";
  if (status === 401 || status === 403 || status === 406 || status === 451) return "block";
  if (status >= 200 && status < 400) return "allow";
  if (status >= 500) return status === 503 ? "error" : "error";
  if (response.decision && OBSERVED_DECISIONS.includes(response.decision)) {
    return response.decision;
  }
  if (response.error && !status) return "error";
  return "error";
}

export function observationRecord({
  testId,
  request,
  response = {},
  expected,
  latencyMs = null,
  telemetry = null,
} = {}) {
  const observed = classifyObserved(response);
  return {
    test_id: testId,
    request: sanitizeRequest(request),
    expected_decision: expected?.decision || "unspecified",
    expected_source: expected?.source || null,
    observed_decision: observed,
    status: response.status ?? response.statusCode ?? null,
    latency: latencyMs,
    response_metadata: {
      headers: sanitizeHeaders(response.headers),
      tls: response.tls ? sanitizeTls(response.tls) : null,
      tcp: response.tcp || null,
      httpVersion: response.httpVersion || request?.httpVersion || null,
      error: response.error || null,
      code: response.code || null,
    },
    telemetry: telemetry && typeof telemetry === "object" ? telemetry : { available: false },
  };
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = String(name).toLowerCase();
    if (/(?:authorization|cookie|set-cookie|proxy-authorization|x-api-key)/i.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = String(value ?? "").slice(0, 200);
  }
  return out;
}

function sanitizeTls(tls) {
  return {
    protocol: tls.protocol || null,
    cipher: tls.cipher || null,
    sni: tls.sni || null,
    authorized: tls.authorized ?? null,
    alpn: tls.alpn || null,
  };
}

function sanitizeRequest(request = {}) {
  const copy = { ...(request || {}) };
  if (typeof copy.body === "string") {
    copy.bodySize = copy.body.length;
    copy.bodyKind = copy.bodyKind || "text";
    delete copy.body;
  } else if (copy.body) {
    copy.bodyKind = copy.bodyKind || "present";
    delete copy.body;
  }
  if (copy.headers) copy.headers = sanitizeHeaders(copy.headers);
  return copy;
}
