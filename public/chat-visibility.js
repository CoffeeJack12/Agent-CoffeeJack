/**
 * Chat UI visibility policy: hide routine internal execution from the bubble stream.
 * Activity log still stores tool events; this only gates inline chat cards.
 */

const ACTIONABLE_TOOLS = new Set([
  "research",
  "web_search",
  "browser",
  "screenshot",
  "read_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "run_terminal",
  "run_tests",
  "run_check",
]);

const HIDDEN_COUNCIL_DETAILS = /^(council_off|not_warranted|skipped|fast_path|off)$/i;

/**
 * Whether a streamed council event should appear inline in chat.
 * Skipped / unwarranted council never shows. Completed council with proposals may.
 */
export function shouldShowCouncilInChat(item = {}) {
  if (!item) return false;
  if (item.type && item.type !== "council") return false;
  const status = String(item.status || "").toLowerCase();
  const detail = String(item.detail || item.triggerReason || "").toLowerCase();
  if (status === "skipped" || status === "off") return false;
  if (HIDDEN_COUNCIL_DETAILS.test(detail)) return false;
  if (/council_off|not_warranted|fast_path/.test(detail)) return false;
  // Meaningful council output: proposals, verification, or evidence types.
  if (item.proposals?.length) return true;
  if (item.verification || item.evidenceTypes?.length) return true;
  if (status === "done" && item.title && !/skipped/i.test(item.title)) return true;
  return false;
}

/**
 * Routine successful tool runs stay out of chat; actionable / error / artifact stay.
 */
export function shouldShowToolInChat(item = {}) {
  if (!item?.name) return false;
  const status = String(item.status || "").toLowerCase();
  if (status === "error") return true;
  if (status === "running") {
    // Only surface running state for tools the user would care to watch.
    return (
      ACTIONABLE_TOOLS.has(item.name) ||
      item.name === "research" ||
      item.name === "browser"
    );
  }
  if (status !== "done") return false;

  // Artifact / screenshot results the user asked for.
  if (
    item.result?.image &&
    /^\/artifacts\/[a-z]+-\d+\.png$/.test(item.result.image)
  )
    return true;

  // Research with real sources.
  if (
    (item.name === "research" || item.name === "web_search") &&
    (item.result?.sources?.length || item.result?.results?.length)
  )
    return true;

  // File/write results that expose a path or diff the user requested.
  if (
    ["write_file", "edit_file", "apply_patch", "read_file"].includes(item.name) &&
    (item.result?.path || item.result?.diff || item.result?.content)
  )
    return true;

  // Terminal / test output only when there is meaningful output (not empty ok).
  if (
    ["run_terminal", "run_tests", "run_check"].includes(item.name) &&
    (item.result?.output || item.result?.code != null)
  )
    return true;

  // Hide ordinary internal successes: recall, search_code, inspect_pc, remember, etc.
  return false;
}

/** Collapsed Details only when at least one useful internal item exists. */
export function shouldShowMessageDetails(items = []) {
  return items.some(
    (item) =>
      (item.type === "council" && shouldShowCouncilInChat(item)) ||
      (item.type === "tool" && shouldShowToolInChat(item)) ||
      item.type === "approval" ||
      item.type === "self_repair" ||
      (item.type === "memory" && item.pending?.length),
  );
}
