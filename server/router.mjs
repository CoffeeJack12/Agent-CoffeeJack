import os from "node:os";

const imagePath = /\.(png|jpe?g|webp)$/i;
const coding =
  /\b(code|coding|program|programming|debug|bug|repo|repository|git|tests?|javascript|typescript|python|html|css|sql|api|compile|lint|refactor|architecture|website)\b|برمج|كود|مستودع|اختبار|تصحيح|موقع|تطبيق/i;

export function classifyTask({
  text = "",
  mode = "auto",
  attachments = [],
  history = [],
}) {
  if (!["auto", "general", "coding", "vision"].includes(mode))
    throw new Error("Invalid task mode");
  if (attachments.some((p) => imagePath.test(p)) || mode === "vision")
    return "vision";
  if (mode !== "auto") return mode;
  if (
    coding.test(text) ||
    attachments.some((p) => /\.(m?js|tsx?|py|html|css|json|sql)$/i.test(p))
  )
    return "coding";
  if (
    /^(continue|fix it|try again|go on|كمل|تابع|صلحه)[.!؟\s]*$/i.test(
      text.trim(),
    )
  ) {
    const previous = history.filter((m) => m.role === "user").at(-1);
    if (previous && coding.test(previous.content)) return "coding";
  }
  return "general";
}

export async function routeModel({
  ollama,
  settings,
  signal,
  memoryBytes = os.totalmem(),
  ...task
}) {
  signal?.throwIfAborted();
  const kind = classifyTask(task);
  const installed = (await ollama.models(signal)).filter(
    (m) => !m.remote_host && !/(?:^|[-:])cloud(?:$|:)/i.test(m.name),
  );
  const preferred =
    kind === "vision"
      ? settings.visionModel
      : kind === "coding"
        ? settings.codingModel
        : settings.model;
  const normalize = (name) =>
    name && (name.includes(":") ? name : name + ":latest");
  const candidates = [
    ...new Set(
      [preferred, settings.model, ...installed.map((m) => m.name)].filter(
        Boolean,
      ),
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
    if (kind === "coding" && !capabilities.includes("tools")) continue;
    const supportedContext = Object.entries(info.model_info ?? {})
      .filter(([key]) => key.endsWith(".context_length"))
      .map(([, value]) => Number(value))
      .filter((n) => n > 0);
    const context = Math.min(
      kind === "coding" && memoryBytes >= 24 * 1024 ** 3 ? 16384 : 8192,
      ...supportedContext,
    );
    return {
      kind,
      model: entry.name,
      capabilities,
      fallback:
        normalize(entry.name) !== normalize(preferred || settings.model),
      reason:
        kind === "vision"
          ? "Verified image-capable local model"
          : kind === "coding"
            ? "Coding workflow with local tools"
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
