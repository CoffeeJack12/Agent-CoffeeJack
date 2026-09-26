/**
 * Firewall differential matrix: source × destination × protocol × port.
 */

export function buildFirewallMatrix({ intended = [], observed = [], previous = null } = {}) {
  const rows = [];
  for (const rule of intended || []) {
    const key = matrixKey(rule);
    const seen = (observed || []).find((row) => matrixKey(row) === key);
    const expected = String(rule.expected || rule.decision || "").toLowerCase() || "unspecified";
    const got = seen
      ? String(seen.observed || seen.decision || "").toLowerCase()
      : "unspecified";
    const result =
      expected === "unspecified"
        ? "no_expectation"
        : !seen
          ? "not_tested"
          : expected === got
            ? "match"
            : "mismatch";
    rows.push({
      source: rule.source || null,
      destination: rule.destination || rule.dest || null,
      protocol: rule.protocol || "tcp",
      port: rule.port ?? null,
      expected,
      observed: seen ? got : null,
      result,
    });
  }
  return {
    rows,
    mismatches: rows.filter((row) => row.result === "mismatch"),
    before_after: previous ? compareMatrices(previous, rows) : null,
  };
}

export function matrixKey(row = {}) {
  return [
    String(row.source || "*").toLowerCase(),
    String(row.destination || row.dest || "*").toLowerCase(),
    String(row.protocol || "tcp").toLowerCase(),
    String(row.port ?? "*"),
  ].join("|");
}

export function compareMatrices(beforeRows, afterRows) {
  const before = new Map((beforeRows.rows || beforeRows).map((row) => [matrixKey(row), row]));
  const after = new Map((afterRows.rows || afterRows).map((row) => [matrixKey(row), row]));
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changes = [];
  for (const key of keys) {
    const left = before.get(key);
    const right = after.get(key);
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      changes.push({ key, before: left || null, after: right || null });
    }
  }
  return { changed: changes.length, changes };
}
