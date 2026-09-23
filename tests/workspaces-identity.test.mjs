import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAccessGuard } from "../server/access.mjs";
import { createApp } from "../server/index.mjs";
import { Store } from "../server/store.mjs";
import {
  createSession,
  createUser,
  disableUser,
  getSession,
  resolveLocalOwner,
  revokeSession,
} from "../server/users.mjs";
import {
  ensureIdentitySchema,
  linkExternalIdentity,
  resolveExternalIdentity,
  unlinkExternalIdentity,
  findIdentitiesForUser,
} from "../server/identity.mjs";
import {
  ensureWorkspaceSchema,
  ensureOwnerWorkspace,
  ensureUserWorkspace,
  listWorkspacesForUser,
  userCanAccessWorkspace,
  authorizeWorkspacePath,
  getChatWorkspaceId,
  resolveActiveWorkspace,
} from "../server/workspaces.mjs";
import { buildEvidencePack } from "../server/council.mjs";
import { workspacePath } from "../server/files.mjs";
import { authorize, canToggleGaming } from "../server/permissions.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const config = {
  hostname: "jack.example.com",
  teamDomain: "jack-test.cloudflareaccess.com",
  audience: "b".repeat(64),
  emails: ["owner@example.com", "usera@example.com"],
};
const clock = 1800000000000;
const key = {
  ...publicKey.export({ format: "jwk" }),
  kid: "ws-key",
  use: "sig",
};

function jwt(overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "ws-key" }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: "https://" + config.teamDomain,
      aud: [config.audience],
      exp: clock / 1000 + 300,
      email: "owner@example.com",
      sub: "cf-owner-sub",
      ...overrides,
    }),
  ).toString("base64url");
  const sig = sign(
    "RSA-SHA256",
    Buffer.from(header + "." + body),
    privateKey,
  ).toString("base64url");
  return `${header}.${body}.${sig}`;
}

async function tempDir(t, prefix = "cj-ws-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    for (let i = 0; i < 8; i++) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        return;
      } catch (error) {
        if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
        await new Promise((r) => setTimeout(r, 40 * (i + 1)));
      }
    }
  });
  return dir;
}

async function running(t, { remote = false } = {}) {
  const dir = await tempDir(t);
  const access = remote
    ? createAccessGuard(
        { ...config },
        {
          fetcher: async () => ({
            ok: true,
            json: async () => ({ keys: [key] }),
          }),
          now: () => clock,
        },
      )
    : null;
  if (remote) process.env.CF_ACCESS_OWNER_EMAIL = "owner@example.com";
  const app = await createApp({
    dataDirectory: dir,
    root: dir,
    remoteAccess: access,
    ollama: {
      models: async () => [{ name: "test" }],
      inspect: async () => ({ capabilities: ["tools"] }),
      prepare: async () => {},
      unload: async () => [],
      chat: async ({ onToken }) => {
        onToken("ok");
        return { role: "assistant", content: "ok", tokens: 1 };
      },
    },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    delete process.env.CF_ACCESS_OWNER_EMAIL;
    try {
      app.server.closeAllConnections?.();
    } catch {
      /* ignore */
    }
    await app.close();
  });
  const port = app.server.address().port;
  return {
    app,
    dir,
    port,
    base: `http://127.0.0.1:${port}`,
    hostHeader: remote ? config.hostname : `127.0.0.1:${port}`,
  };
}

function req(base, hostHeader, token, route, method = "GET", body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(new URL(base).port),
        path: route,
        method,
        headers: {
          Host: hostHeader,
          "Content-Type": "application/json",
          "X-CoffeeJack-Token": token || "",
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
          resolve({
            status: res.statusCode,
            json: async () => data,
            body: data,
          });
        });
      },
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function remoteReq(
  port,
  route,
  { token, jwt: assertion, method = "GET", body } = {},
) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        headers: {
          Host: config.hostname,
          "Content-Type": "application/json",
          Connection: "close",
          ...(token ? { "X-CoffeeJack-Token": token } : {}),
          ...(assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
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
          resolve({ status: res.statusCode, data });
        });
      },
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

test("external identity mapping links owner by subject and rejects unknown", async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir);
  t.after(() => store.close());
  ensureIdentitySchema(store);
  const owner = resolveLocalOwner(store);
  const linked = linkExternalIdentity(store, {
    subject: "sub-owner",
    email: "owner@example.com",
    userId: owner.id,
  });
  assert.equal(linked.user_id, owner.id);
  const again = resolveExternalIdentity(store, {
    subject: "sub-owner",
    email: "owner@example.com",
  });
  assert.equal(again.status, "mapped");
  assert.equal(again.user.id, owner.id);
  const pending = resolveExternalIdentity(store, {
    subject: "stranger",
    email: "stranger@example.com",
  });
  assert.equal(pending.status, "pending");
  unlinkExternalIdentity(store, {
    subject: "sub-owner",
    actorUserId: owner.id,
  });
  assert.equal(findIdentitiesForUser(store, owner.id).length, 0);
});

test("owner auto-link uses explicit verified email list only", async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir);
  t.after(() => store.close());
  ensureIdentitySchema(store);
  const owner = resolveLocalOwner(store);
  const mapped = resolveExternalIdentity(
    store,
    { subject: "cf-1", email: "owner@example.com" },
    { ownerAutoLinkEmails: ["owner@example.com"] },
  );
  assert.equal(mapped.status, "mapped");
  assert.equal(mapped.user.id, owner.id);
  const other = resolveExternalIdentity(
    store,
    { subject: "cf-2", email: "other@example.com" },
    { ownerAutoLinkEmails: ["owner@example.com"] },
  );
  assert.equal(other.status, "pending");
});

test("disabled mapped user is denied", async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir);
  t.after(() => store.close());
  ensureIdentitySchema(store);
  const user = createUser(store, { displayName: "Temp", role: "standard" });
  linkExternalIdentity(store, {
    subject: "temp-sub",
    email: "temp@example.com",
    userId: user.id,
  });
  disableUser(store, user.id);
  const resolved = resolveExternalIdentity(store, {
    subject: "temp-sub",
    email: "temp@example.com",
  });
  assert.equal(resolved.status, "denied");
  assert.equal(resolved.reason, "disabled_user");
});

test("local owner bootstrap still works without login friction", async (t) => {
  const { base, hostHeader } = await running(t);
  const res = await req(base, hostHeader, "", "/api/status");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.user.role, "owner");
  assert.equal(data.identitySource, "local");
  assert.ok(data.activeWorkspace?.name);
  assert.ok(data.token);
});

test("remote mapped owner session never falls back for unknown identity", async (t) => {
  const { app, port } = await running(t, { remote: true });
  const owner = resolveLocalOwner(app.store);
  linkExternalIdentity(app.store, {
    subject: "cf-owner-sub",
    email: "owner@example.com",
    userId: owner.id,
  });
  const ok = await remoteReq(port, "/api/status", { jwt: jwt() });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.id, owner.id);
  assert.equal(ok.data.identitySource, "cloudflare");

  const pending = await remoteReq(port, "/api/status", {
    jwt: jwt({ email: "usera@example.com", sub: "unknown-sub" }),
  });
  assert.equal(pending.status, 403);
  assert.equal(pending.data.code, "pending_identity");
});

test("expired and wrong audience/issuer tokens fail safely", async (t) => {
  const { port } = await running(t, { remote: true });
  for (const overrides of [
    { exp: clock / 1000 - 10 },
    { aud: ["wrong"] },
    { iss: "https://evil.cloudflareaccess.com" },
  ]) {
    const res = await remoteReq(port, "/api/status", {
      jwt: jwt(overrides),
    });
    assert.equal(res.status, 403);
  }
});

test("remote cannot use local profile switching", async (t) => {
  const { app, port } = await running(t, { remote: true });
  const owner = resolveLocalOwner(app.store);
  linkExternalIdentity(app.store, {
    subject: "cf-owner-sub",
    email: "owner@example.com",
    userId: owner.id,
  });
  const other = createUser(app.store, {
    displayName: "UserA",
    role: "standard",
  });
  const status = await remoteReq(port, "/api/status", { jwt: jwt() });
  assert.equal(status.status, 200);
  const switchRes = await remoteReq(port, "/api/session/switch", {
    method: "POST",
    token: status.data.token,
    jwt: jwt(),
    body: { userId: other.id },
  });
  assert.equal(switchRes.status, 403);
});

test("spoofed CF headers on loopback do not become remote owner", async (t) => {
  const { base, hostHeader } = await running(t);
  const res = await req(base, hostHeader, "", "/api/status", "GET", undefined, {
    "Cf-Access-Jwt-Assertion": jwt({ email: "attacker@evil.com", sub: "x" }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.identitySource, "local");
  assert.equal(data.user.role, "owner");
});

test("session revocation and expiry reject access", async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir);
  t.after(() => store.close());
  const owner = resolveLocalOwner(store);
  const session = createSession(store, owner.id, {
    source: "remote",
    ttlMs: 1,
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(getSession(store, session.token), undefined);
  const live = createSession(store, owner.id, { source: "local" });
  revokeSession(store, live.token);
  assert.equal(getSession(store, live.token), undefined);
});

test("owner workspace migration preserves root and other users get private roots", async (t) => {
  const dir = await tempDir(t);
  const repo = path.join(dir, "repo");
  await fs.mkdir(repo);
  const store = new Store(dir);
  t.after(() => store.close());
  ensureWorkspaceSchema(store);
  store.set("workspace", repo);
  const owner = resolveLocalOwner(store);
  const a = await ensureOwnerWorkspace(store, {
    root: repo,
    dataDirectory: dir,
  });
  const b = await ensureOwnerWorkspace(store, {
    root: repo,
    dataDirectory: dir,
  });
  assert.equal(a.id, b.id);
  assert.equal(path.resolve(a.root_path), path.resolve(repo));
  const userA = createUser(store, { displayName: "UserA", role: "standard" });
  const userB = createUser(store, { displayName: "UserB", role: "standard" });
  const wa = await ensureUserWorkspace(store, userA.id, dir);
  const wb = await ensureUserWorkspace(store, userB.id, dir);
  assert.notEqual(wa.root_path, a.root_path);
  assert.notEqual(wa.root_path, wb.root_path);
  assert.equal(userCanAccessWorkspace(store, userA.id, a.id), false);
  assert.equal(userCanAccessWorkspace(store, userA.id, wb.id), false);
  assert.equal(userCanAccessWorkspace(store, owner.id, wa.id), false);
});

test("active workspace binds per chat and path escape fails", async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir);
  t.after(() => store.close());
  ensureWorkspaceSchema(store);
  const owner = resolveLocalOwner(store);
  const ws = await ensureOwnerWorkspace(store, {
    root: dir,
    dataDirectory: dir,
  });
  const chat = store.createChat("hi", owner.id, ws.id);
  assert.equal(getChatWorkspaceId(store, chat.id), ws.id);
  const resolved = await resolveActiveWorkspace(store, owner, {
    chatId: chat.id,
    dataDirectory: dir,
    root: dir,
  });
  assert.equal(resolved.id, ws.id);
  assert.throws(() => authorizeWorkspacePath(ws, "../escape"));
  await assert.rejects(() => workspacePath(ws.root_path, "../escape"));
  await assert.rejects(() =>
    workspacePath(ws.root_path, "C:\\Windows\\System32"),
  );
});

test("cross-user workspace IDOR denied via API", async (t) => {
  const { app, base, hostHeader, dir } = await running(t);
  const ownerToken = (await req(base, hostHeader, "", "/api/status")).body
    .token;
  const userA = createUser(app.store, {
    displayName: "UserA",
    role: "standard",
  });
  await ensureUserWorkspace(app.store, userA.id, dir);
  const switchRes = await req(
    base,
    hostHeader,
    ownerToken,
    "/api/session/switch",
    "POST",
    { userId: userA.id },
  );
  assert.equal(switchRes.status, 200);
  const aToken = switchRes.body.token;
  const ownerWs = listWorkspacesForUser(
    app.store,
    resolveLocalOwner(app.store).id,
  )[0];
  const deny = await req(
    base,
    hostHeader,
    aToken,
    "/api/workspaces/active",
    "POST",
    { workspaceId: ownerWs.id },
  );
  assert.equal(deny.status, 403);
});

test("permission integration: workspace ownership does not bypass guest deny", () => {
  const guest = {
    id: "g",
    role: "guest",
    status: "active",
    display_name: "G",
  };
  const decision = authorize({
    user: guest,
    capability: "files_write",
    resource: { id: "ws", owner_user_id: "g" },
  });
  assert.equal(decision.decision, "deny");
  assert.equal(canToggleGaming(guest), false);
});

test("research evidence extracts sources from slim and nested tool payloads", () => {
  const pack = buildEvidencePack([
    {
      chat_id: "c1",
      tool: "research",
      status: "done",
      detail: JSON.stringify({
        args: { query: "ollama" },
        result: {
          sources: [
            {
              title: "Docs",
              url: "https://ollama.com/docs",
              domain: "ollama.com",
            },
          ],
          searchResults: [{ title: "Blog", url: "https://ollama.com/blog" }],
          summary: "facts",
        },
      }),
    },
  ]);
  assert.equal(pack.research.sources.length, 2);
  assert.equal(pack.research.sources[0].domain, "ollama.com");
  assert.ok(pack.research.keyFacts.includes("facts"));
});

test("research evidence recovers sources from truncated event JSON", () => {
  const truncated =
    '{"args":{"query":"x"},"result":{"sources":[{"title":"One","url":"https://example.com/a"},{"title":"Two","url":"https://example.com/b","content":"' +
    "x".repeat(25000);
  const pack = buildEvidencePack([
    {
      chat_id: "c1",
      tool: "research",
      status: "done",
      detail: truncated,
    },
  ]);
  assert.ok(pack.research.sources.length >= 1);
  assert.equal(pack.research.sources[0].url, "https://example.com/a");
});

test("gaming_toggle permission unchanged for standard remote-shaped user", () => {
  const standard = {
    id: "s",
    role: "standard",
    status: "active",
    display_name: "S",
  };
  assert.equal(canToggleGaming(standard), false);
  assert.equal(
    authorize({ user: standard, capability: "desktop_control" }).decision,
    "deny",
  );
});

test("mapping removed denies subsequent remote status", async (t) => {
  const { app, port } = await running(t, { remote: true });
  const owner = resolveLocalOwner(app.store);
  linkExternalIdentity(app.store, {
    subject: "cf-owner-sub",
    email: "owner@example.com",
    userId: owner.id,
  });
  const first = await remoteReq(port, "/api/status", { jwt: jwt() });
  assert.equal(first.status, 200);
  unlinkExternalIdentity(app.store, {
    subject: "cf-owner-sub",
    actorUserId: owner.id,
  });
  delete process.env.CF_ACCESS_OWNER_EMAIL;
  const second = await remoteReq(port, "/api/status", {
    token: first.data.token,
    jwt: jwt(),
  });
  assert.equal(second.status, 403);
});
