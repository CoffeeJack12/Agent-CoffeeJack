/**
 * Defensive security regression tests — local fixtures and mocks only.
 * Covers authz boundaries, workspace confinement, session revoke, and bind policy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { createAccessGuard } from "../server/access.mjs";
import {
  createSession,
  createUser,
  resolveLocalOwner,
  revokeSession,
  getSession,
  disableUser,
} from "../server/users.mjs";
import {
  ensureUserWorkspace,
  ensureOwnerWorkspace,
  listWorkspacesForUser,
  authorizeWorkspacePath,
} from "../server/workspaces.mjs";
import { workspacePath } from "../server/files.mjs";
import { assertLocalOllamaUrl } from "../server/ollama.mjs";
import { classifyRequest } from "../server/trust.mjs";
import { linkExternalIdentity } from "../server/identity.mjs";

const fakeOllama = {
  models: async () => [{ name: "test" }],
  inspect: async () => ({ capabilities: ["tools"] }),
  prepare: async () => {},
  unload: async () => [],
  chat: async ({ onToken }) => {
    onToken("ok");
    return { role: "assistant", content: "ok", tokens: 1 };
  },
};

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-sec-"));
  t.after(async () => {
    for (let i = 0; i < 6; i++) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 40 * (i + 1)));
      }
    }
  });
  return dir;
}

async function localApp(t) {
  const dir = await tempDir(t);
  const app = await createApp({
    dataDirectory: dir,
    root: dir,
    ollama: fakeOllama,
  });
  app.store.set("autoGaming", false);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections?.();
    await app.close();
  });
  const port = app.server.address().port;
  return {
    app,
    dir,
    port,
    base: `http://127.0.0.1:${port}`,
  };
}

function req(port, route, { token = "", method = "GET", body, host = "127.0.0.1", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        headers: {
          Host: host,
          "Content-Type": "application/json",
          "X-CoffeeJack-Token": token,
          Connection: "close",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            data = { raw: text };
          }
          resolve({ status: res.statusCode, headers: res.headers, data, text });
        });
      },
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

test("security headers present on local API responses", async (t) => {
  const { port, app } = await localApp(t);
  const res = await req(port, "/api/status", { token: app.token });
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.ok(res.headers["content-security-policy"]);
  assert.equal(res.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(res.headers["cross-origin-resource-policy"], "same-origin");
  assert.match(String(res.headers["cache-control"] || ""), /no-store/);
  assert.equal(res.headers["strict-transport-security"], undefined);
});

test("cross-user chats memories events and workspaces stay isolated", async (t) => {
  const { app, port, dir } = await localApp(t);
  const owner = resolveLocalOwner(app.store);
  const userA = createUser(app.store, { displayName: "UserA", role: "standard" });
  const userB = createUser(app.store, { displayName: "UserB", role: "standard" });
  await ensureUserWorkspace(app.store, userA.id, dir);
  await ensureUserWorkspace(app.store, userB.id, dir);
  const tokenA = createSession(app.store, userA.id).token;
  const tokenB = createSession(app.store, userB.id).token;

  const mem = await req(port, "/api/memories", {
    token: tokenA,
    method: "POST",
    body: { content: "secret-a-note", kind: "note" },
  });
  assert.equal(mem.status, 200);

  const chat = app.store.createChat("A private", userA.id);
  app.store.event(chat.id, "read_file", { args: { path: "a.txt" } }, "done");

  assert.equal((await req(port, "/api/memories", { token: tokenB })).data.length, 0);
  assert.equal((await req(port, "/api/chats", { token: tokenB })).data.length, 0);
  assert.equal(
    (await req(port, `/api/chats/${chat.id}`, { token: tokenB })).status,
    404,
  );
  const eventsB = await req(port, "/api/events", { token: tokenB });
  assert.ok(
    !(eventsB.data || []).some((e) => e.chat_id === chat.id),
    "B must not see A's tool events",
  );

  const ownerWs = listWorkspacesForUser(app.store, owner.id)[0];
  const deny = await req(port, "/api/workspaces/active", {
    token: tokenA,
    method: "POST",
    body: { workspaceId: ownerWs.id },
  });
  assert.equal(deny.status, 403);

  const listA = await req(port, "/api/workspaces", { token: tokenA });
  assert.ok(!listA.data.workspaces.some((w) => w.id === ownerWs.id));
});

test("stop cannot cancel another user's active task", async (t) => {
  let resolveGate;
  const gate = new Promise((r) => {
    resolveGate = r;
  });
  const ollama = {
    ...fakeOllama,
    chat: async ({ onToken, signal }) => {
      resolveGate();
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 15000);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true },
        );
      });
      onToken("late");
      return { role: "assistant", content: "late", tokens: 1 };
    },
  };
  const dir = await tempDir(t);
  const app = await createApp({
    dataDirectory: dir,
    root: dir,
    ollama,
  });
  app.store.set("autoGaming", false);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections?.();
    await app.close();
  });
  const port = app.server.address().port;
  const other = createUser(app.store, { displayName: "Other", role: "standard" });
  const otherToken = createSession(app.store, other.id).token;

  const chatPromise = req(port, "/api/chat", {
    token: app.token,
    method: "POST",
    body: { text: "long owner task" },
  });
  await gate;
  const stop = await req(port, "/api/stop", {
    token: otherToken,
    method: "POST",
  });
  assert.equal(stop.status, 403);
  // Owner can stop their own task
  assert.equal(
    (await req(port, "/api/stop", { token: app.token, method: "POST" })).status,
    200,
  );
  await chatPromise;
});

test("artifacts require an authenticated session", async (t) => {
  const { app, port, dir } = await localApp(t);
  const name = `browser-${Date.now()}.png`;
  await fs.writeFile(path.join(dir, "artifacts", name), Buffer.from([137, 80, 78, 71]));
  const denied = await req(port, `/artifacts/${name}`);
  assert.equal(denied.status, 403);
  const ok = await req(port, `/artifacts/${name}`, { token: app.token });
  assert.equal(ok.status, 200);
});

test("invalid session and revoked session are rejected", async (t) => {
  const { app, port } = await localApp(t);
  assert.equal(
    (await req(port, "/api/chats", { token: "not-a-real-token" })).status,
    403,
  );
  const session = createSession(app.store, resolveLocalOwner(app.store).id);
  revokeSession(app.store, session.token);
  assert.equal(getSession(app.store, session.token), undefined);
  assert.equal(
    (await req(port, "/api/chats", { token: session.token })).status,
    403,
  );
});

test("disabled user sessions are rejected", async (t) => {
  const { app, port } = await localApp(t);
  const user = createUser(app.store, { displayName: "Temp", role: "standard" });
  const token = createSession(app.store, user.id).token;
  disableUser(app.store, user.id);
  assert.equal((await req(port, "/api/chats", { token })).status, 403);
});

test("filesystem confinement rejects absolute UNC and parent escapes", async (t) => {
  const dir = await tempDir(t);
  const wsRoot = path.join(dir, "ws");
  await fs.mkdir(wsRoot);
  await assert.rejects(() => workspacePath(wsRoot, "../secret"));
  await assert.rejects(() => workspacePath(wsRoot, "C:\\Windows\\win.ini"));
  await assert.rejects(() => workspacePath(wsRoot, "\\\\server\\share\\x"));
  assert.throws(() =>
    authorizeWorkspacePath({ root_path: wsRoot }, "..\\owner"),
  );
  const ok = await workspacePath(wsRoot, "ok.txt", { write: true });
  assert.ok(ok.startsWith(await fs.realpath(wsRoot)) || ok.includes("ok.txt"));
});

test("OLLAMA_URL must stay on loopback by default", () => {
  assert.equal(assertLocalOllamaUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.throws(() => assertLocalOllamaUrl("http://8.8.8.8:11434"), /loopback|127/);
  assert.throws(() => assertLocalOllamaUrl("http://example.com:11434"), /loopback|127/);
  const prev = process.env.COFFEEJACK_ALLOW_REMOTE_OLLAMA;
  process.env.COFFEEJACK_ALLOW_REMOTE_OLLAMA = "1";
  try {
    assert.equal(
      assertLocalOllamaUrl("http://10.0.0.5:11434"),
      "http://10.0.0.5:11434",
    );
  } finally {
    if (prev === undefined) delete process.env.COFFEEJACK_ALLOW_REMOTE_OLLAMA;
    else process.env.COFFEEJACK_ALLOW_REMOTE_OLLAMA = prev;
  }
});

test("Cloudflare-forwarded loopback never grants local-owner bootstrap", async (t) => {
  assert.equal(
    classifyRequest(
      {
        headers: {
          host: "127.0.0.1:3210",
          "cf-ray": "x",
          "x-forwarded-for": "1.2.3.4",
        },
      },
      { accessConfigured: true, accessHostname: "jack.example.com" },
    ).mode,
    "remote",
  );

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const config = {
    hostname: "jack.example.com",
    teamDomain: "jack-test.cloudflareaccess.com",
    audience: "e".repeat(64),
    emails: ["owner@example.com"],
  };
  const clock = 1800000000000;
  const key = { ...publicKey.export({ format: "jwk" }), kid: "sec", use: "sig" };
  function jwt() {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "sec" }),
    ).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({
        iss: "https://" + config.teamDomain,
        aud: [config.audience],
        exp: clock / 1000 + 300,
        email: "owner@example.com",
        sub: "owner-sub",
      }),
    ).toString("base64url");
    const sig = sign(
      "RSA-SHA256",
      Buffer.from(header + "." + body),
      privateKey,
    ).toString("base64url");
    return `${header}.${body}.${sig}`;
  }
  const dir = await tempDir(t);
  process.env.CF_ACCESS_OWNER_EMAIL = "owner@example.com";
  t.after(() => delete process.env.CF_ACCESS_OWNER_EMAIL);
  const access = createAccessGuard(config, {
    fetcher: async () => ({ ok: true, json: async () => ({ keys: [key] }) }),
    now: () => clock,
  });
  const app = await createApp({
    dataDirectory: dir,
    root: dir,
    remoteAccess: access,
    ollama: fakeOllama,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections?.();
    await app.close();
  });
  const port = app.server.address().port;
  const spoof = await req(port, "/api/status", {
    host: "127.0.0.1",
    headers: {
      "Cf-Ray": "1",
      "Cf-Access-Authenticated-User-Email": "owner@example.com",
      "X-Forwarded-For": "9.9.9.9",
    },
  });
  assert.equal(spoof.status, 403);

  linkExternalIdentity(app.store, {
    subject: "owner-sub",
    email: "owner@example.com",
    userId: resolveLocalOwner(app.store).id,
  });
  const ok = await req(port, "/api/status", {
    host: config.hostname,
    headers: { "Cf-Access-Jwt-Assertion": jwt() },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.identitySource, "cloudflare");
  assert.ok(ok.headers["strict-transport-security"]);
});

test("owner workspace migration remains available to owner only", async (t) => {
  const dir = await tempDir(t);
  const repo = path.join(dir, "repo");
  await fs.mkdir(repo);
  const { Store } = await import("../server/store.mjs");
  const { ensureWorkspaceSchema } = await import("../server/workspaces.mjs");
  const store = new Store(dir);
  t.after(() => store.close());
  ensureWorkspaceSchema(store);
  store.set("workspace", repo);
  const owner = resolveLocalOwner(store);
  const ws = await ensureOwnerWorkspace(store, {
    root: repo,
    dataDirectory: dir,
  });
  const other = createUser(store, { displayName: "Other", role: "standard" });
  assert.equal(ws.owner_user_id, owner.id);
  assert.equal(
    listWorkspacesForUser(store, other.id).some((w) => w.id === ws.id),
    false,
  );
});
