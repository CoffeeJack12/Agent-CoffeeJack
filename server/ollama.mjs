export function buildChatRequest({ model, messages, tools, profile = {} }) {
  return {
    model,
    messages,
    ...(tools?.length ? { tools } : {}),
    stream: true,
    think: profile.think ?? false,
    keep_alive: "3m",
    options: {
      num_ctx: profile.context ?? 8192,
      num_predict: profile.predict ?? 3072,
      temperature: 0.7,
      top_p: 0.95,
      top_k: 20,
    },
  };
}

/** Keep Ollama on loopback unless explicitly overridden for owned labs. */
export function assertLocalOllamaUrl(url = "http://127.0.0.1:11434") {
  const raw = String(url || "http://127.0.0.1:11434").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("OLLAMA_URL must be a valid http(s) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("OLLAMA_URL must use http or https");
  const host = parsed.hostname.toLowerCase();
  const loopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback && process.env.COFFEEJACK_ALLOW_REMOTE_OLLAMA !== "1")
    throw new Error(
      "OLLAMA_URL must target 127.0.0.1/localhost (set COFFEEJACK_ALLOW_REMOTE_OLLAMA=1 only for owned lab setups)",
    );
  return raw.replace(/\/$/, "");
}

export class Ollama {
  constructor(url = "http://127.0.0.1:11434") {
    this.url = assertLocalOllamaUrl(url);
  }
  async request(endpoint, body, signal) {
    const response = await fetch(this.url + endpoint, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ?? AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error(`Ollama: ${(await response.text()).slice(0, 500)}`);
    return response;
  }
  async models(signal) {
    return (
      (await (await this.request("/api/tags", undefined, signal)).json())
        .models ?? []
    );
  }
  async inspect(model, signal) {
    return (await this.request("/api/show", { model }, signal)).json();
  }
  async prepare(model, signal) {
    const loaded =
      (await (await this.request("/api/ps", undefined, signal)).json())
        .models ?? [];
    for (const entry of loaded) {
      signal?.throwIfAborted();
      if (entry.name !== model)
        await this.request(
          "/api/generate",
          { model: entry.name, keep_alive: 0 },
          signal,
        );
    }
  }
  async unload() {
    const loaded = (await (await this.request("/api/ps")).json()).models ?? [];
    await Promise.all(
      loaded.map((m) =>
        this.request(
          "/api/generate",
          { model: m.name, keep_alive: 0 },
          AbortSignal.timeout(30000),
        ),
      ),
    );
    return loaded.map((m) => m.name);
  }
  async chat({ model, messages, tools, profile, signal, onToken }) {
    const response = await this.request(
      "/api/chat",
      buildChatRequest({ model, messages, tools, profile }),
      signal,
    );
    const decoder = new TextDecoder();
    let buffer = "",
      content = "",
      toolCalls = [],
      tokens = 0;
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const part = JSON.parse(line);
        if (part.error) throw new Error(part.error);
        if (part.message?.content) {
          content += part.message.content;
          onToken?.(part.message.content);
        }
        if (part.message?.tool_calls)
          toolCalls.push(...part.message.tool_calls);
        if (part.eval_count) tokens = part.eval_count;
      }
    }
    return {
      role: "assistant",
      content,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      tokens,
    };
  }
}
