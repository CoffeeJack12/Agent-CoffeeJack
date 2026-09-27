/**
 * Development-only / telemetry turn latency markers.
 * Enable console logging with COFFEEJACK_DEV_TIMING=1.
 */

export function createTurnTiming() {
  const t0 = performance.now();
  const marks = { t0, request_received: t0 };
  return {
    mark(name) {
      marks[name] = performance.now();
    },
    has(name) {
      return marks[name] != null;
    },
    measure(name, from = "t0") {
      const end = marks[name] ?? performance.now();
      const start = marks[from] ?? t0;
      return Math.max(0, Math.round(end - start));
    },
    snapshot(extra = {}) {
      const now = performance.now();
      return {
        request_received_ms: 0,
        context_resolution_ms: num(marks, "context_resolved", "request_received"),
        routing_ms: num(marks, "routing_done", "context_resolved"),
        memory_ms: num(marks, "memory_done", "memory_start"),
        council_ms: num(marks, "council_done", "council_start"),
        tool_planning_ms: num(marks, "tools_planned", "tool_plan_start"),
        model_prepare_ms: num(marks, "model_ready", "prepare_start"),
        ollama_request_ms: num(marks, "ollama_request_sent", "model_ready"),
        first_ollama_token_ms: num(marks, "first_token", "ollama_request_sent"),
        first_ui_token_ms: num(marks, "first_token", "request_received"),
        guard_ms: num(marks, "guard_done", "guard_start"),
        revise_ms: num(marks, "revise_done", "revise_start"),
        jeddawi_render_ms: num(marks, "jeddawi_render_done", "jeddawi_render_start"),
        jeddawi_guard_ms: num(marks, "jeddawi_guard_done", "jeddawi_guard_start"),
        core_generation_ms: (() => {
          const core = num(marks, "core_generation_done", "first_token");
          if (core != null) return core;
          const viaRender = num(marks, "jeddawi_render_start", "first_token");
          if (viaRender != null && viaRender > 0) return viaRender;
          return num(marks, "generation_done", "first_token");
        })(),
        renderer_used: marks.jeddawi_render_done != null,
        renderer_ms: num(marks, "jeddawi_render_done", "jeddawi_render_start"),
        // Legacy aliases kept for existing consumers.
        context_build_ms: num(marks, "context_done", "routing_done"),
        model_load_ms: num(marks, "model_ready", "prepare_start"),
        first_token_ms: num(marks, "first_token", "model_ready"),
        generation_ms: num(marks, "generation_done", "first_token"),
        tool_ms: num(marks, "tools_done", "tools_start"),
        total_ms: Math.round(now - t0),
        model_already_loaded: marks.model_already_loaded === true,
        ...extra,
      };
    },
    setFlag(name, value = true) {
      marks[name] = value;
    },
    log(label, extra = {}) {
      if (!devTimingEnabled()) return this.snapshot(extra);
      const snap = this.snapshot(extra);
      console.info(`[latency] ${label}`, snap);
      return snap;
    },
  };
}

function num(marks, endKey, startKey) {
  if (marks[endKey] == null || marks[startKey] == null) return null;
  return Math.max(0, Math.round(marks[endKey] - marks[startKey]));
}

export function devTimingEnabled() {
  return (
    process.env.COFFEEJACK_DEV_TIMING === "1" ||
    process.env.COFFEEJACK_DEV_TIMING === "true"
  );
}
