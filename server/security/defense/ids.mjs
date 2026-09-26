/**
 * Safe synthetic IDS/IPS validation. No attack payloads.
 */

import { securityResult } from "../evidence.mjs";
import { assertAuthorizedTarget } from "./authorized.mjs";

export const SYNTHETIC_IDS_TESTS = Object.freeze([
  {
    id: "CJ-SYNTH-HTTP-CANARY",
    expectedDetection: "CoffeeJack synthetic HTTP canary",
    kind: "http",
    path: "/coffeejack-ids-canary",
  },
  {
    id: "CJ-SYNTH-DNS-CANARY",
    expectedDetection: "CoffeeJack synthetic DNS canary",
    kind: "dns",
    name: "ids-canary.coffeejack.test",
  },
]);

export async function validateIds({
  testId,
  target,
  allowlist = [],
  send,
  detector,
  clock = () => new Date().toISOString(),
} = {}) {
  const spec = SYNTHETIC_IDS_TESTS.find((t) => t.id === testId);
  if (!spec) {
    return securityResult({
      tool: "security_ids_validation",
      error:
        "Only catalogued synthetic tests are allowed. Custom IDS payloads are rejected.",
      observed: { testId: testId || null },
    });
  }
  if (spec.kind === "http") {
    const auth = assertAuthorizedTarget(target, allowlist);
    if (!auth.ok) {
      return securityResult({
        tool: "security_ids_validation",
        error: auth.error,
        observed: { testId: spec.id, authorized: false },
      });
    }
  }
  const timestamp = clock();
  const sent = typeof send === "function" ? await send(spec) : { sent: false };
  const detected =
    typeof detector === "function" ? await detector(spec, sent) : sent.detected;
  const observedDetection = Boolean(detected);
  return securityResult({
    tool: "security_ids_validation",
    observed: {
      testId: spec.id,
      sentTest: spec.kind,
      timestamp,
      sent: sent.sent !== false,
      observedDetection,
      evidence: sent.evidence || detected?.evidence || null,
    },
    expected: [spec.expectedDetection],
    mismatch: observedDetection
      ? []
      : [`Expected detection "${spec.expectedDetection}" was not observed.`],
    possibleCause: observedDetection
      ? []
      : ["The sensor is not watching this path, or the synthetic event was not ingested."],
    recommendedRemediation: observedDetection
      ? []
      : ["Confirm the sensor subscription, then repeat this same synthetic canary."],
    unverified: [
      "A synthetic canary is not proof that real attacks would be detected.",
    ],
  });
}
