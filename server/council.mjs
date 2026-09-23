/**
 * Bounded AI Council — multi-model consultation without parallel tool agents.
 * Models propose text only; Jack remains the sole tool executor.
 */

const EXPLICIT =
  /\b(?:consult (?:other )?models?|ask the council|second opinion|ai council|council of models)\b|استشر|مجلس الذكاء/i;
const COMPLEX =
  /\b(?:architect(?:ure)?|refactor (?:the )?(?:entire |whole )?|difficult bug|root cause|compare approaches|trade-?offs?|deep research|carefully reason)\b|إعادة هيكلة|سبب جذري|عمارة/i;
const SIMPLE =
  /^(?:hi|hello|hey|thanks|thank you|ok|okay|yo|مرحبا|هلا|شكرا)[.!؟\s]*$/i;

export function shouldConsultCouncil({
  text = "",
  preferences = {},
  gaming = false,
  effectiveMode = "auto",
  availableModels = [],
  failedAttempts = 0,
} = {}) {
  const mode = preferences.councilMode || "auto";
  if (gaming || mode === "off")
    return { consult: false, reason: gaming ? "gaming" : "council_off" };
  const distinct = uniqueModels(availableModels);
  if (distinct.length < 2)
    return {
      consult: false,
      reason: "one_model_available",
      available: distinct.length,
    };
  if (EXPLICIT.test(text))
    return { consult: true, reason: "explicit_request" };
  if (SIMPLE.test(text.trim()) || effectiveMode === "empathy")
    return { consult: false, reason: "simple_or_empathy" };
  if (mode === "on" && (COMPLEX.test(text) || failedAttempts >= 1))
    return { consult: true, reason: "council_on_complex" };
  if (mode === "auto" && (COMPLEX.test(text) || failedAttempts >= 2))
    return { consult: true, reason: "auto_complex" };
  return { consult: false, reason: "not_warranted" };
}

function uniqueModels(models) {
  const seen = new Set();
  const out = [];
  for (const m of models) {
    const key = `${m.provider || "ollama"}:${m.id || m.name || m.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

export function selectCouncilParticipants(models, { max = 2, gaming } = {}) {
  if (gaming) return [];
  const distinct = uniqueModels(models).filter((m) => m.local !== false || true);
  // Prefer local models first for privacy/cost.
  const ranked = [...distinct]
    .filter((m) => m && (m.id || m.name || m.model))
    .sort((a, b) => {
    const al = a.local === false ? 1 : 0;
    const bl = b.local === false ? 1 : 0;
    return al - bl;
  });
  const limit = Math.max(2, Math.min(4, Number(max) || 2));
  return ranked.slice(0, limit).map((m, i) => ({
    ...m,
    role: i === 0 ? "primary" : i === 1 ? "critic" : "specialist",
  }));
}

/**
 * Run council proposals (text-only). Does not execute tools.
 * chatFn({ model, provider, messages, signal }) → { content }
 */
export async function runCouncil({
  participants,
  prompt,
  context = "",
  chatFn,
  signal,
} = {}) {
  if (!participants?.length)
    return {
      skipped: true,
      reason: "no_participants",
      proposals: [],
    };
  if (participants.length < 2)
    return {
      skipped: true,
      reason: "one_model_available",
      proposals: [],
      available: participants.length,
    };

  const proposals = [];
  for (const member of participants) {
    signal?.throwIfAborted();
    const system =
      member.role === "critic"
        ? "You are a critic. List flaws, risks and missing checks in the proposal. Be concise. Do not claim to run tools."
        : member.role === "specialist"
          ? "You are a specialist. Give a focused alternative approach. Do not claim to run tools."
          : "You are the primary analyst. Propose a clear plan. Do not claim to run tools.";
    try {
      const result = await chatFn({
        model: member.id || member.model,
        provider: member.provider || "ollama",
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content:
              (context ? `Context:\n${context.slice(0, 6000)}\n\n` : "") +
              `Task:\n${prompt}`,
          },
        ],
        signal,
      });
      proposals.push({
        model: member.id || member.model,
        provider: member.provider || "ollama",
        role: member.role,
        status: "ok",
        content: String(result?.content || "").slice(0, 4000),
      });
    } catch (error) {
      proposals.push({
        model: member.id || member.model,
        provider: member.provider || "ollama",
        role: member.role,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ok = proposals.filter((p) => p.status === "ok");
  const synthesis =
    ok.length === 0
      ? ""
      : ok.length === 1
        ? ok[0].content
        : [
            "Council synthesis (proposals only; Jack executes tools):",
            ...ok.map(
              (p) =>
                `- ${p.role} (${p.provider}/${p.model}): ${p.content.slice(0, 800)}`,
            ),
          ].join("\n");

  return {
    skipped: false,
    proposals,
    rejected: proposals.filter((p) => p.status !== "ok").length,
    synthesis,
    modelsConsulted: ok.length,
  };
}

export function councilUiSummary(result) {
  if (!result || result.skipped) {
    return {
      title: "AI Council",
      status: "skipped",
      detail:
        result?.reason === "one_model_available"
          ? "1 model available — consultation skipped"
          : result?.reason || "skipped",
    };
  }
  return {
    title: "AI Council",
    status: "done",
    detail: `${result.modelsConsulted} models consulted${result.rejected ? `, ${result.rejected} failed` : ""}`,
    proposals: result.proposals.map((p) => ({
      model: p.model,
      provider: p.provider,
      role: p.role,
      status: p.status,
    })),
  };
}
