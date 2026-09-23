import os from "node:os";
import { modelTaskKind } from "./auto-mode.mjs";

const imagePath = /\.(png|jpe?g|webp)$/i;
const TASK_MODES = ["auto", "general", "coding", "vision"];

export function classifyTask({
  text = "",
  mode = "auto",
  attachments = [],
  history = [],
  effectiveMode,
} = {}) {
  if (!TASK_MODES.includes(mode)) throw new Error("Invalid task mode");
  if (attachments.some((p) => imagePath.test(p)) || mode === "vision")
    return "vision";
  if (mode !== "auto") return mode;
  return modelTaskKind({
    effectiveMode: effectiveMode || "auto",
    text,
    attachments,
    history,
  });
}

/**
 * Model selection.
 * requestedModel: "auto" | concrete installed name
 * Manual lock when requestedModel !== "auto".
 */
export async function routeModel({
  ollama,
  settings,
  signal,
  memoryBytes = os.totalmem(),
  requestedModel = "auto",
  gaming = false,
  effectiveMode,
  ...task
}) {
  signal?.throwIfAborted();
  const kind = classifyTask({ ...task, effectiveMode });
  const installed = (await ollama.models(signal)).filter(
    (m) => !m.remote_host && !/(?:^|[-:])cloud(?:$|:)/i.test(m.name),
  );
  const normalize = (name) =>
    name && (name.includes(":") ? name : name + ":latest");
  const locked =
    requestedModel &&
    requestedModel !== "auto" &&
    installed.some((m) => normalize(m.name) === normalize(requestedModel));
  const preferred = locked
    ? requestedModel
    : kind === "vision"
      ? settings.visionModel
      : kind === "coding"
        ? settings.codingModel || settings.model
        : settings.model;
  const candidates = [
    ...new Set(
      [
        preferred,
        settings.model,
        ...installed.map((m) => m.name),
      ].filter(Boolean),
    ),
  ];
  for (const candidate of candidates) {
    const entry = installed.find(
      (m) => normalize(m.name) === normalize(candidate),
    );
    if (!entry) continue;
    signal?.throwIfAborted();
    const info = await ollama.inspect(entry.name, signal);
    const capabilities = info.capabilities ?? [];
    if (kind === "vision" && !capabilities.includes("vision")) continue;
    if (kind === "coding" && !capabilities.includes("tools") && !locked)
      continue;
    void gaming;
    const supportedContext = Object.entries(info.model_info ?? {})
      .filter(([key]) => key.endsWith(".context_length"))
      .map(([, value]) => Number(value))
      .filter((n) => n > 0);
    const context = Math.min(
      kind === "coding" && memoryBytes >= 24 * 1024 ** 3 ? 16384 : 8192,
      ...(supportedContext.length ? supportedContext : []),
    );
    return {
      kind,
      model: entry.name,
      requestedModel: requestedModel || "auto",
      effectiveModel: entry.name,
      capabilities,
      fallback:
        normalize(entry.name) !== normalize(preferred || settings.model),
      reason: locked
        ? "Manual model lock"
        : kind === "vision"
          ? "Verified image-capable local model"
          : kind === "coding"
            ? "Coding workflow with local tools"
            : requestedModel === "auto"
              ? "Auto model selection"
              : "General conversation",
      profile: {
        think:
          kind === "coding" && capabilities.includes("thinking")
            ? /^gpt-oss/i.test(entry.name)
              ? "medium"
              : true
            : false,
        context,
        predict: kind === "coding" ? 4096 : 3072,
      },
    };
  }
  throw new Error(
    kind === "vision"
      ? "No installed local vision model is available. Configure a vision-capable model before sending images."
      : "No compatible local model is installed. Check the model settings and Ollama.",
  );
}
