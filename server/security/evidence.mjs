/**
 * Evidence labels for security tool results.
 * observed = extracted facts
 * derived = bounded calculations
 * assessment = interpretation that still cites evidence
 * unverified = not proven
 */

const FORBIDDEN_ABSOLUTES =
  /\b(?:malware confirmed|safe|clean|packed|compromised)\b/i;

function asList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

export function securityResult({
  tool,
  observed = {},
  derived = {},
  assessment = [],
  unverified = [],
  expected = [],
  mismatch = [],
  possibleCause = [],
  recommendedRemediation = [],
  available = true,
  error = null,
} = {}) {
  const assessments = asList(assessment);
  for (const line of assessments) {
    if (FORBIDDEN_ABSOLUTES.test(String(line))) {
      throw new Error(
        "Security assessment used a forbidden absolute claim without evidence labels",
      );
    }
  }
  return {
    tool,
    available,
    error,
    observed,
    derived,
    expected: asList(expected),
    mismatch: asList(mismatch),
    possibleCause: asList(possibleCause),
    recommendedRemediation: asList(recommendedRemediation),
    assessment: assessments,
    unverified: asList(unverified),
  };
}

export function slimSecurityForRemote(result = {}, { maxChars = 4000 } = {}) {
  const observed = result.observed && typeof result.observed === "object"
    ? { ...result.observed }
    : {};
  delete observed.strings;
  delete observed.disassembly;
  delete observed.decompilation;
  delete observed.payload;
  delete observed.packets;
  delete observed.raw;
  delete observed.bytes;
  delete observed.hex;
  delete observed.certPem;
  delete observed.chainPem;
  delete observed.banner;
  delete observed.body;
  delete observed.requestBody;
  delete observed.headers;
  if (Array.isArray(observed.imports))
    observed.imports = observed.imports.slice(0, 40);
  if (Array.isArray(observed.exports))
    observed.exports = observed.exports.slice(0, 40);
  if (Array.isArray(observed.sections))
    observed.sections = observed.sections.map((s) => ({
      name: s.name,
      entropy: s.entropy,
      permissions: s.permissions,
      virtualSize: s.virtualSize,
    }));
  const out = {
    tool: result.tool,
    available: result.available,
    error: result.error || null,
    observed: {
      ...observed,
      note: "Sanitized security summary. Raw binary, captures, and decompilation omitted.",
    },
    derived: result.derived || {},
    expected: (result.expected || []).slice(0, 8),
    mismatch: (result.mismatch || []).slice(0, 8),
    possibleCause: (result.possibleCause || []).slice(0, 8),
    recommendedRemediation: (result.recommendedRemediation || []).slice(0, 8),
    assessment: (result.assessment || []).slice(0, 8),
    unverified: (result.unverified || []).slice(0, 8),
  };
  const json = JSON.stringify(out);
  if (json.length <= maxChars) return out;
  return {
    tool: result.tool,
    available: result.available,
    observed: {
      fileName: observed.fileName,
      sha256: observed.sha256,
      format: observed.format,
      note: "Sanitized and truncated security summary.",
    },
    derived: {},
    assessment: [],
    unverified: ["Full security result omitted for remote providers."],
  };
}

export function assertNoForbiddenAbsolutes(text = "") {
  return !FORBIDDEN_ABSOLUTES.test(String(text));
}
