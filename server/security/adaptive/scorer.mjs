/**
 * Compare expected vs observed and choose the next bounded lab tests.
 */

export const HARD_BUDGETS = Object.freeze({
  maxRounds: 10,
  maxCasesPerRound: 25,
  maxCasesPerRun: 200,
});

export function clampBudgets(input = {}) {
  const maxRounds = Math.min(
    HARD_BUDGETS.maxRounds,
    Math.max(1, Number(input.maxRounds ?? input.max_rounds ?? HARD_BUDGETS.maxRounds)),
  );
  const maxCasesPerRound = Math.min(
    HARD_BUDGETS.maxCasesPerRound,
    Math.max(1, Number(input.maxCasesPerRound ?? input.max_cases_per_round ?? HARD_BUDGETS.maxCasesPerRound)),
  );
  const maxCasesPerRun = Math.min(
    HARD_BUDGETS.maxCasesPerRun,
    Math.max(1, Number(input.maxCasesPerRun ?? input.max_cases_per_run ?? HARD_BUDGETS.maxCasesPerRun)),
  );
  return { maxRounds, maxCasesPerRound, maxCasesPerRun };
}

export function remainingBudget({ used = 0, round = 0, budgets = HARD_BUDGETS } = {}) {
  const limits = clampBudgets(budgets);
  return {
    ...limits,
    used,
    round,
    remainingRun: Math.max(0, limits.maxCasesPerRun - used),
    remainingRound: limits.maxCasesPerRound,
    roundsLeft: Math.max(0, limits.maxRounds - round),
    exhausted: used >= limits.maxCasesPerRun || round >= limits.maxRounds,
  };
}

export function compareExpectedObserved(expected, observed) {
  const exp = expected?.decision || expected || "unspecified";
  const obs = observed?.decision || observed || "error";
  const match = exp !== "unspecified" && exp === obs;
  const gap = exp !== "unspecified" && exp !== obs;
  const bypass = exp === "block" && obs === "allow";
  return {
    expected: exp,
    observed: obs,
    match,
    gap,
    bypass,
    interesting: gap || (exp === "unspecified" && obs === "allow" && observed?.baseline === "block"),
  };
}

export function scoreCase(recorded, { baseline = null } = {}) {
  const cmp = compareExpectedObserved(
    recorded.expected_decision,
    recorded.observed_decision,
  );
  let score = 0;
  if (cmp.bypass) score += 100;
  else if (cmp.gap) score += 60;
  if (baseline?.observed_decision === "block" && recorded.observed_decision === "allow") {
    score += 40;
  }
  if (baseline && recorded.observed_decision !== baseline.observed_decision) score += 20;
  if (recorded.category === "path_normalization" && cmp.gap) score += 10;
  return { ...cmp, score, category: recorded.category, case_id: recorded.case_id };
}

export function selectNextTests({
  cases = [],
  lessons = [],
  generateRelated,
  budget = 25,
  targetId,
} = {}) {
  const scopedLessons = (lessons || []).filter((lesson) => lesson.target_id === targetId);
  const ranked = [...cases]
    .map((row) => scoreCase(row, { baseline: cases.find((c) => c.phase === "baseline") }))
    .sort((a, b) => b.score - a.score);
  const seed = ranked.find((row) => row.interesting || row.gap || row.score >= 40);
  if (!seed || typeof generateRelated !== "function") return [];
  const lessonHint = scopedLessons.find((lesson) => lesson.control && lesson.target_id === targetId);
  const family = generateRelated(cases.find((c) => c.case_id === seed.case_id) || seed, {
    budget,
    lesson: lessonHint || null,
  });
  const seen = new Set(cases.map((c) => c.case_id));
  return (family || []).filter((row) => !seen.has(row.case_id)).slice(0, budget);
}
