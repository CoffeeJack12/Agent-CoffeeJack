/**
 * Controlled rate-limit validation. Hard-bounded. No traffic floods.
 */

export const RATE_HARD = Object.freeze({
  maxRequestRate: 20,
  maxDurationMs: 15000,
  maxTotalRequests: 100,
});

export function clampRatePlan(input = {}) {
  const expectedThreshold = Math.max(1, Number(input.expectedThreshold ?? input.expected_threshold ?? 5));
  const maxRequestRate = Math.min(
    RATE_HARD.maxRequestRate,
    Math.max(1, Number(input.maxRequestRate ?? input.max_request_rate ?? 5)),
  );
  const durationMs = Math.min(
    RATE_HARD.maxDurationMs,
    Math.max(200, Number(input.durationMs ?? input.duration ?? 2000)),
  );
  const planned = Math.min(
    RATE_HARD.maxTotalRequests,
    Math.ceil((maxRequestRate * durationMs) / 1000),
  );
  return { expectedThreshold, maxRequestRate, durationMs, planned };
}

export async function runRateLimitTest({
  target,
  send,
  expectedThreshold,
  maxRequestRate,
  durationMs,
  signal,
  pathName = "/",
} = {}) {
  const plan = clampRatePlan({ expectedThreshold, maxRequestRate, duration: durationMs });
  if (typeof send !== "function") {
    return {
      available: false,
      error: "Rate-limit send adapter is not configured.",
      plan,
      fabricated: false,
    };
  }
  const samples = [];
  const started = Date.now();
  let throttledAt = null;
  let firstThrottleStatus = null;
  for (let i = 0; i < plan.planned; i += 1) {
    if (signal?.aborted) break;
    if (Date.now() - started > plan.durationMs) break;
    const t0 = Date.now();
    const response = await send({
      target_id: target.target_id,
      method: "GET",
      path: pathName,
      headers: { accept: "text/plain", "x-coffeejack-lab": "rate-limit" },
      kind: "rate_limit",
    });
    const latency = Date.now() - t0;
    const status = response?.status ?? response?.statusCode ?? null;
    samples.push({ i, status, latency, decision: response?.decision || null });
    if ((status === 429 || response?.decision === "throttle") && throttledAt == null) {
      throttledAt = i + 1;
      firstThrottleStatus = status || 429;
    }
    const interval = Math.floor(1000 / plan.maxRequestRate);
    if (interval > 0 && i + 1 < plan.planned) {
      await wait(interval, signal);
    }
  }
  const recovered = await measureRecovery({ send, target, pathName, signal });
  return {
    available: true,
    plan,
    target_id: target.target_id,
    when_throttling_begins: throttledAt,
    status_code: firstThrottleStatus,
    backoff_behavior: firstThrottleStatus === 429 ? "http_429" : throttledAt ? "decision_throttle" : "none_observed",
    recovery_time_ms: recovered,
    samples: samples.slice(0, 40),
    bounded: true,
    flood: false,
  };
}

async function measureRecovery({ send, target, pathName, signal }) {
  const t0 = Date.now();
  for (let i = 0; i < 5; i += 1) {
    if (signal?.aborted) return null;
    await wait(30, signal);
    const response = await send({
      target_id: target.target_id,
      method: "GET",
      path: pathName,
      headers: { accept: "text/plain" },
      kind: "rate_limit_recovery",
    });
    const status = response?.status ?? response?.statusCode;
    if (status && status !== 429 && response?.decision !== "throttle") {
      return Date.now() - t0;
    }
  }
  return null;
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
