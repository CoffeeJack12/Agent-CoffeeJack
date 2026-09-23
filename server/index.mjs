import { getPreferences, savePreferences, LANGUAGES, MODES, PACKS, PREFERENCE_OPTIONS } from "./preferences.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { accessFromEnvironment } from "./access.mjs";
import { Store } from "./store.mjs";
import { Ollama } from "./ollama.mjs";
import { Tools, runProcess } from "./tools.mjs";
import { routeModel } from "./router.mjs";
import { runAgent } from "./agent.mjs";
import { workspacePath } from "./files.mjs";
import { getPersona, validatePersona, selfModel } from "./personality.mjs";

export async function createApp({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  dataDirectory,
  ollama: providedOllama,
  remoteAccess,
} = {}) {
  const access = remoteAccess ?? accessFromEnvironment();
  const data = dataDirectory ?? path.join(root, ".local");
  const artifacts = path.join(data, "artifacts");
  await fs.mkdir(artifacts, { recursive: true });
  const store = new Store(data);
  const token = randomBytes(32).toString("hex");
  const ollama = providedOllama ?? new Ollama(process.env.OLLAMA_URL);
  const approvals = new Map();
  let active = null,
    gaming = false,
    autoGaming = false,
    gameScanBusy = false;
  let workspace = store.get("workspace", path.join(data, "projects"));
  await fs.mkdir(workspace, { recursive: true });
  const settings = () => ({
    model: store.get("model", process.env.COFFEEJACK_MODEL ?? "qwen3:8b"),
    codingModel: store.get("codingModel", ""),
    visionModel: store.get("visionModel", ""),
    instructions: store.get("instructions", ""),
    workspace,
    autoApprove: store.get("autoApprove", false),
    gameProcesses: store.get("gameProcesses", [
      "cs2.exe",
      "cod.exe",
      "FortniteClient-Win64-Shipping.exe",
      "Cyberpunk2077.exe",
      "eldenring.exe",
      "GTA5.exe",
    ]),
    autoGaming: store.get("autoGaming", true),
  });
  const tools = new Tools({
    root,
    workspace,
    store,
    artifactDirectory: artifacts,
    approve: async (name, args, signal) => {
      if (store.get("autoApprove", false)) return;
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const finish = (allowed) => {
          clearTimeout(timer);
          approvals.delete(id);
          signal.removeEventListener("abort", cancel);
          allowed
            ? resolve()
            : reject(new Error("Operation declined or expired"));
        };
        const cancel = () => finish(false);
        const timer = setTimeout(cancel, 300000);
        approvals.set(id, { id, name, args, finish });
        signal.addEventListener("abort", cancel, { once: true });
        active?.emit({ type: "approval", id, name, args });
      });
    },
  });
  const setGaming = async (enabled) => {
    gaming = enabled;
    if (enabled) {
      const previous = active;
      previous?.controller.abort();
      if (previous) await previous.finished;
      await tools.close();
      return await ollama.unload();
    }
    return [];
  };
  const scanGames = async () => {
    if (
      gameScanBusy ||
      process.platform !== "win32" ||
      !store.get("autoGaming", true)
    )
      return;
    gameScanBusy = true;
    try {
      const result = await runProcess("tasklist.exe", ["/FO", "CSV", "/NH"], {
        timeout: 5000,
      });
      const names = result.output
        .split("\n")
        .map((l) => l.match(/^"([^"]+)"/)?.[1]?.toLowerCase())
        .filter(Boolean);
      const found = settings().gameProcesses.some((p) =>
        names.includes(p.toLowerCase()),
      );
      if (found && !gaming) {
        autoGaming = true;
        await setGaming(true);
      } else if (!found && autoGaming) {
        autoGaming = false;
        await setGaming(false);
      }
    } catch {
      /* Manual gaming mode remains available if process detection fails. */
    } finally {
      gameScanBusy = false;
    }
  };
  const timer = setInterval(scanGames, 15000);
  timer.unref();
  const json = (res, code, value) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  const body = async (req) => {
    let bytes = 0,
      chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 30000000) throw new Error("Request too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const host = req.headers.host ?? "";
    const localHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
    if (!localHost) {
      if (!access || host !== access.hostname)
        return json(res, 403, { error: "Invalid host" });
      if (!(await access.authorize(req)))
        return json(res, 403, { error: "Remote authentication required" });
    }
    const expectedOrigin = (localHost ? "http://" : "https://") + host;
    if (
      (req.headers.origin && req.headers.origin !== expectedOrigin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return json(res, 403, { error: "Cross-origin request denied" });
    const url = new URL(req.url, `http://${host}`);
    const route = url.pathname;
    try {
      if (
        route.startsWith("/api/") &&
        req.method !== "GET" &&
        req.headers["x-coffeejack-token"] !== token
      )
        return json(res, 403, { error: "Invalid session token" });
      if (route === "/api/status" && req.method === "GET") {
        let models = [],
          modelError = "";
        try {
          models = await ollama.models();
        } catch (e) {
          modelError = e.message;
        }
        return json(res, 200, {
          token,
          models,
          modelError,
          settings: settings(),
          preferences: getPreferences(store),
          gaming,
          autoGaming,
          busy: Boolean(active),
          jack: selfModel(store, { active: Boolean(active), gaming }),
          approvals: [...approvals.values()].map(({ id, name, args }) => ({
            id,
            name,
            args,
          })),
        });
      }
      if (route === "/api/chats" && req.method === "GET")
        return json(res, 200, store.chats());
      if (route.startsWith("/api/chats/") && req.method === "GET") {
        const id = route.split("/").pop();
        if (!store.chat(id)) return json(res, 404, { error: "Chat not found" });
        return json(res, 200, store.messages(id));
      }
      if (route.startsWith("/api/chats/") && req.method === "DELETE") {
        const id = route.split("/").pop();
        if (active?.chatId === id)
          return json(res, 409, { error: "Stop the active chat first" });
        store.deleteChat(id);
        return json(res, 200, { ok: true });
      }
      if (route === "/api/memories" && req.method === "GET")
        return json(res, 200, store.memories(url.searchParams.get("q") ?? ""));
      if (route === "/api/memories" && req.method === "POST") {
        const b = await body(req);
        if (typeof b.content !== "string" || !b.content.trim())
          throw new Error("Memory is empty");
        return json(res, 200, {
          id: store.remember(b.content, b.kind ?? "note", workspace),
        });
      }
      if (route.startsWith("/api/memories/") && req.method === "DELETE") {
        store.forget(route.split("/").pop());
        return json(res, 200, { ok: true });
      }
      if (route === "/api/events" && req.method === "GET")
        return json(res, 200, store.events());
      if (route === "/api/preferences" && req.method === "GET")
        return json(res,200,{preferences:getPreferences(store),catalog:{languages:LANGUAGES,modes:MODES,packs:PACKS,options:PREFERENCE_OPTIONS}});
      if (route === "/api/preferences" && req.method === "POST") {
        if(active)return json(res,409,{error:"Stop the active task before changing preferences"});
        return json(res,200,savePreferences(store,await body(req)));
      }
      if (route === "/api/persona" && req.method === "GET")
        return json(
          res,
          200,
          selfModel(store, { active: Boolean(active), gaming }),
        );
      if (route === "/api/persona" && req.method === "POST") {
        const input = validatePersona(await body(req));
        if (active)
          return json(res, 409, {
            error: "أوقف المهمة الحالية قبل تعديل شخصية Jack.",
          });
        store.set("persona", { ...getPersona(store), ...input });
        const preferencePatch={};
        if(input.language)preferencePatch.language=input.language;
        if(input.humor)preferencePatch.humor=({off:"off",subtle:"dry",playful:"dark"})[input.humor];
        if(input.detail)preferencePatch.verbosity=({concise:"concise",balanced:"normal",thorough:"detailed"})[input.detail];
        savePreferences(store,preferencePatch);
        return json(res, 200, selfModel(store, { active: false, gaming }));
      }
      if (route === "/api/settings" && req.method === "POST") {
        if (active)
          return json(res, 409, {
            error: "Stop the current task before changing settings",
          });
        const b = await body(req);
        for (const key of [
          "model",
          "codingModel",
          "visionModel",
          "instructions",
        ])
          if (key in b && (typeof b[key] !== "string" || b[key].length > 8000))
            throw new Error("Invalid setting");
        for (const key of ["autoApprove", "autoGaming"])
          if (key in b && typeof b[key] !== "boolean")
            throw new Error("Invalid toggle");
        if (
          "gameProcesses" in b &&
          (!Array.isArray(b.gameProcesses) ||
            b.gameProcesses.length > 100 ||
            b.gameProcesses.some(
              (p) => typeof p !== "string" || !/^[\w .-]+\.exe$/i.test(p),
            ))
        )
          throw new Error("Invalid game executable names");
        if ("workspace" in b) {
          if (typeof b.workspace !== "string" || !path.isAbsolute(b.workspace))
            throw new Error("Workspace must be an absolute path");
          const stat = await fs.stat(b.workspace);
          if (!stat.isDirectory())
            throw new Error("Workspace must be a folder");
          workspace = await fs.realpath(b.workspace);
          tools.workspace = workspace;
          store.set("workspace", workspace);
        }
        for (const key of [
          "model",
          "codingModel",
          "visionModel",
          "instructions",
          "autoApprove",
          "gameProcesses",
          "autoGaming",
        ])
          if (key in b) store.set(key, b[key]);
        return json(res, 200, settings());
      }
      if (route === "/api/gaming" && req.method === "POST") {
        const b = await body(req);
        if (typeof b.enabled !== "boolean") throw new Error("Invalid mode");
        autoGaming = false;
        const unloaded = await setGaming(b.enabled);
        return json(res, 200, { gaming, unloaded });
      }
      if (route === "/api/stop" && req.method === "POST") {
        active?.controller.abort();
        return json(res, 200, { ok: true });
      }
      if (route.startsWith("/api/approve/") && req.method === "POST") {
        const b = await body(req);
        const pending = approvals.get(route.split("/").pop());
        if (!pending) return json(res, 404, { error: "Approval expired" });
        pending.finish(b.allow === true);
        return json(res, 200, { ok: true });
      }
      if (route === "/api/upload" && req.method === "POST") {
        const b = await body(req);
        if (typeof b.name !== "string" || typeof b.data !== "string")
          throw new Error("Invalid upload");
        const ext = path.extname(b.name).toLowerCase();
        if (
          ![
            ".txt",
            ".md",
            ".csv",
            ".tsv",
            ".json",
            ".js",
            ".ts",
            ".py",
            ".html",
            ".css",
            ".pdf",
            ".docx",
            ".xlsx",
            ".png",
            ".jpg",
            ".jpeg",
            ".webp",
          ].includes(ext)
        )
          throw new Error("Unsupported attachment type");
        const buffer = Buffer.from(b.data, "base64");
        if (buffer.length > 20 * 1024 * 1024) throw new Error("20 MB maximum");
        const name = `${randomUUID()}-${path.basename(b.name).replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
        const destination = await workspacePath(workspace, `uploads/${name}`, {
          write: true,
        });
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, buffer);
        return json(res, 200, { path: `uploads/${name}`, name: b.name });
      }
      if (route === "/api/chat" && req.method === "POST") {
        if (gaming)
          return json(res, 409, {
            error: "وضع الألعاب مفعّل. أوقفه لبدء المحادثة.",
          });
        if (active) return json(res, 409, { error: "هناك مهمة قيد التنفيذ." });
        const b = await body(req);
        if (
          typeof b.text !== "string" ||
          !b.text.trim() ||
          b.text.length > 30000
        )
          throw new Error("Message must contain 1–30000 characters");
        if (
          b.attachments &&
          (!Array.isArray(b.attachments) ||
            b.attachments.length > 5 ||
            b.attachments.some((v) => typeof v !== "string"))
        )
          throw new Error("Invalid attachments");
        // Requests can interleave while their body is arriving.
        if (active || gaming)
          return json(res, 409, {
            error: "المهمة مشغولة أو وضع الألعاب مفعّل.",
          });
        const chat = b.chatId ? store.chat(b.chatId) : store.createChat(b.text);
        if (!chat) throw new Error("Chat not found");
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        const emit = (event) => {
          if (!res.destroyed) res.write(JSON.stringify(event) + "\n");
        };
        const controller = new AbortController();
        let finish;
        const finished = new Promise((resolve) => {
          finish = resolve;
        });
        active = { controller, chatId: chat.id, emit, finished };
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
        });
        emit({ type: "chat", chat });
        const conf = settings();
        try {
          const routing = await routeModel({
            ollama,
            settings: conf,
            text: b.text,
            mode: b.mode && b.mode !== "auto" ? b.mode : getPreferences(store).mode === "developer" ? "coding" : "auto",
            attachments: b.attachments ?? [],
            history: store.messages(chat.id),
            signal: controller.signal,
          });
          emit({
            type: "routing",
            model: routing.model,
            kind: routing.kind,
            fallback: routing.fallback,
            reason: routing.reason,
          });
          await ollama.prepare?.(routing.model, controller.signal);
          await runAgent({
            store,
            ollama,
            tools,
            chatId: chat.id,
            text: b.text,
            attachments: b.attachments,
            model: routing.model,
            profile: routing.profile,
            capabilities: routing.capabilities,
            gaming,
            signal: controller.signal,
            emit,
          });
        } catch (e) {
          emit({
            type: "error",
            error: controller.signal.aborted ? "تم إيقاف المهمة." : e.message,
          });
        } finally {
          active = null;
          finish();
          res.end();
        }
        return;
      }
      if (req.method !== "GET") return json(res, 404, { error: "Not found" });
      let filename;
      if (
        route.startsWith("/artifacts/") &&
        /^[a-z]+-\d+\.png$/.test(path.basename(route))
      )
        filename = path.join(artifacts, path.basename(route));
      else if (
        [
          "/",
          "/app.js",
          "/branding.js",
          "/jack/icon.png",
          "/jack/logo.png",
          "/jack/avatar.png",
          "/style.css",
          "/polish.css",
          "/favicon.svg",
          "/vendor/marked.esm.js",
          "/vendor/purify.es.mjs",
        ].includes(route)
      )
        filename = path.join(
          root,
          "public",
          route === "/" ? "index.html" : route.slice(1),
        );
      else return json(res, 404, { error: "Not found" });
      const content = await fs.readFile(filename);
      const mime = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      res.writeHead(200, {
        "Content-Type": mime[path.extname(filename)],
        "Cache-Control": "no-cache",
      });
      res.end(content);
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: e.message });
      else res.end();
    }
  });
  return {
    server,
    store,
    token,
    close: async () => {
      clearInterval(timer);
      if (active) {
        const run = active;
        run.controller.abort();
        await run.finished;
      }
      await tools.close();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await createApp();
  const port = Number(process.env.COFFEEJACK_PORT ?? 3210);
  app.server.listen(port, "127.0.0.1", () =>
    console.log(`CoffeeJack ready: http://127.0.0.1:${port}`),
  );
  app.server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  for (const event of ["SIGINT", "SIGTERM"])
    process.on(event, async () => {
      await app.close();
      process.exit(0);
    });
}
