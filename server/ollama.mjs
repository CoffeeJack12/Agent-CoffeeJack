export class Ollama {
  constructor(url = "http://127.0.0.1:11434") {
    this.url = url;
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
  async models() {
    return (await (await this.request("/api/tags")).json()).models ?? [];
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
  async chat({ model, messages, tools, signal, onToken }) {
    const response = await this.request(
      "/api/chat",
      {
        model,
        messages,
        ...(tools?.length ? { tools } : {}),
        stream: true,
        think: false,
        keep_alive: "3m",
        options: { num_ctx: 8192, num_predict: 3072, temperature: 0.3 },
      },
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
