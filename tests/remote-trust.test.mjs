import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyRequest,
  hasCloudflareForwardingMarkers,
  expectedOrigin,
} from "../server/trust.mjs";
import { validateAccessEnvironment, createAccessGuard } from "../server/access.mjs";
import { createRateLimiter } from "../server/rate-limit.mjs";
import { createApp } from "../server/index.mjs";
import {
  createUser,
  resolveLocalOwner,
  updateUser,
  getSession,
} from "../server/users.mjs";
import { linkExternalIdentity } from "../server/identity.mjs";

test("classifyRequest: direct loopback is local", () => {
  const c = classifyRequest(
    { headers: { host: "127.0.0.1:3210" } },
    { accessConfigured: true, accessHostname: "jack.example.com" },
  );
  assert.equal(c.mode, "local");
  assert.equal(c.reason, "direct_loopback");
});

test("classifyRequest: spoofed CF markers on local-only loopback stay local", () => {
  const c = classifyRequest(
    {
      headers: {
        host: "127.0.0.1:3210",
        "cf-ray": "abc",
        "cf-access-jwt-assertion": "not.a.jwt",
      },
    },
    { accessConfigured: false, accessHostname: null },
  );
  assert.equal(c.mode, "local");
  assert.equal(c.reason, "direct_loopback");
});

test("validateAccessEnvironment accepts native remote without CF Access vars", () => {
  const native = validateAccessEnvironment({
    COFFEEJACK_REMOTE_AUTH: "native",
    COFFEEJACK_REMOTE_HOST: "coffeejack-agent.com",
  });
  assert.equal(native.ok, true);
  assert.equal(native.mode, "ready");
  assert.equal(native.remoteAuth, "native");
  assert.equal(native.summary.CF_ACCESS_AUD, "not_required");
});

test("classifyRequest: CF markers on loopback are remote (never local owner)", () => {
  const c = classifyRequest(
    {
      headers: {
        host: "127.0.0.1:3210",
        "cf-ray": "abc",
        "cf-connecting-ip": "8.8.8.8",
        "cf-access-authenticated-user-email": "attacker@evil.com",
      },
    },
    { accessConfigured: true, accessHostname: "jack.example.com" },
  );
  assert.equal(c.mode, "remote");
  assert.equal(c.reason, "cloudflare_markers_on_loopback");
  assert.equal(
    hasCloudflareForwardingMarkers({
      headers: { "x-forwarded-for": "1.1.1.1" },
    }),
    false,
  );
});

test("classifyRequest: configured hostname is remote", () => {
  const c = classifyRequest(
    { headers: { host: "jack.example.com" } },
    { accessConfigured: true, accessHostname: "jack.example.com" },
  );
  assert.equal(c.mode, "remote");
  assert.equal(
    expectedOrigin(
      { headers: { host: "jack.example.com" } },
      { mode: "remote", accessHostname: "jack.example.com" },
    ),
    "https://jack.example.com",
  );
});

test("validateAccessEnvironment reports incomplete without weakening", () => {
  const incomplete = validateAccessEnvironment({
    COFFEEJACK_REMOTE_HOST: "jack.example.com",
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.mode, "incomplete");
  assert.ok(incomplete.issues.length);
  const disabled = validateAccessEnvironment({});
  assert.equal(disabled.mode, "disabled");
  assert.equal(disabled.ok, true);
});

test("rate limiter trips after max on remote category", () => {
  let now = 1000;
  const limiter = createRateLimiter({ windowMs: 1000, max: 3, now: () => now });
  const req = { socket: { remoteAddress: "10.0.0.1" } };
  assert.equal(limiter.check(req, "t", 3).ok, true);
  assert.equal(limiter.check(req, "t", 3).ok, true);
  assert.equal(limiter.check(req, "t", 3).ok, true);
  assert.equal(limiter.check(req, "t", 3).ok, false);
  now = 3000;
  assert.equal(limiter.check(req, "t", 3).ok, true);
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const config = {
  hostname: "jack.example.com",
  teamDomain: "jack-test.cloudflareaccess.com",
  audience: "d".repeat(64),
  emails: ["owner@example.com", "testuser@example.com"],
};
const clock = 1800000000000;
const key = {
  ...publicKey.export({ format: "jwk" }),
  kid: "trust-key",
  use: "sig",
};

function jwt(overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "trust-key" }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: "https://" + config.teamDomain,
      aud: [config.audience],
      exp: clock / 1000 + 300,
      email: "owner@example.com",
      sub: "owner-sub",
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

function httpReq(port, route, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload =
      opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method: opts.method || "GET",
        headers: {
          Host: opts.host || "127.0.0.1",
          "Content-Type": "application/json",
          Connection: "close",
          ...(opts.token ? { "X-CoffeeJack-Token": opts.token } : {}),
          ...(opts.jwt ? { "Cf-Access-Jwt-Assertion": opts.jwt } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...opts.headers,
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
            data = {};
          }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function appWithAccess(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-trust-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  process.env.CF_ACCESS_OWNER_EMAIL = "owner@example.com";
  t.after(() => {
    delete process.env.CF_ACCESS_OWNER_EMAIL;
  });
  const access = createAccessGuard(config, {
    fetcher: async () => ({ ok: true, json: async () => ({ keys: [key] }) }),
    now: () => clock,
  });
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
        onToken("x");
        return { role: "assistant", content: "x", tokens: 1 };
      },
    },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.server.closeAllConnections?.();
    await app.close();
  });
  return { app, port: app.server.address().port, dir };
}

test("Access entry navigation allows only verified remote GET documents", async (t) => {
  const { port, dir } = await appWithAccess(t);
  await fs.mkdir(path.join(dir, "public"));
  await fs.writeFile(path.join(dir, "public", "index.html"), "<!doctype html><title>CoffeeJack</title>");
  const headers = {
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
  };
  const base = { host: config.hostname, jwt: jwt(), headers };
  for (const route of ["/", "/?after=access"]) {
    const res = await httpReq(port, route, base);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
  }
  assert.equal((await httpReq(port, "/", {
    ...base, host: "127.0.0.1", headers: { ...headers, "Cf-Ray": "test" },
  })).status, 200);
  for (const opts of [
    { method: "POST" }, { method: "PUT" }, { method: "DELETE" }, { method: "HEAD" },
    { headers: { ...headers, Origin: "https://evil.example" } },
    { headers: { ...headers, Origin: "null" } },
    { headers: { ...headers, "Sec-Fetch-Mode": "cors" } },
    { headers: { ...headers, "Sec-Fetch-Dest": "iframe" } },
    { headers: { "Sec-Fetch-Site": "cross-site" } },
    { jwt: undefined }, { jwt: "invalid" }, { host: "evil.example" },
    { host: "127.0.0.1", jwt: undefined },
  ]) assert.equal((await httpReq(port, "/", { ...base, ...opts })).status, 403);
  for (const route of ["/api/status", "/api/chats", "/app.js"]) {
    const res = await httpReq(port, route, base);
    assert.equal(res.status, 403);
    assert.equal(res.data.error, "Cross-origin request denied");
  }
});

test("forwarded tunnel on loopback never bootstraps local owner", async (t) => {
  const { port } = await appWithAccess(t);
  const res = await httpReq(port, "/api/status", {
    host: "127.0.0.1",
    headers: {
      "Cf-Ray": "1",
      "Cf-Connecting-IP": "9.9.9.9",
      "X-Forwarded-For": "9.9.9.9",
      "Cf-Access-Authenticated-User-Email": "owner@example.com",
    },
  });
  assert.equal(res.status, 403);
  assert.notEqual(res.data.identitySource, "local");
});

test("spoofed Access JWT on tunnel-marked loopback fails closed", async (t) => {
  const { port } = await appWithAccess(t);
  const res = await httpReq(port, "/api/status", {
    host: "127.0.0.1",
    jwt: "not.a.jwt",
    headers: { "Cf-Ray": "1" },
  });
  assert.equal(res.status, 403);
});

test("valid remote owner and TestUser sessions + security headers", async (t) => {
  const { app, port } = await appWithAccess(t);
  const owner = resolveLocalOwner(app.store);
  linkExternalIdentity(app.store, {
    subject: "owner-sub",
    email: "owner@example.com",
    userId: owner.id,
  });
  const ownerRes = await httpReq(port, "/api/status", {
    host: config.hostname,
    jwt: jwt(),
  });
  assert.equal(ownerRes.status, 200);
  assert.equal(ownerRes.data.user.id, owner.id);
  assert.equal(ownerRes.data.identitySource, "cloudflare");
  assert.equal(ownerRes.headers["x-content-type-options"], "nosniff");
  assert.equal(ownerRes.headers["x-frame-options"], "DENY");
  assert.ok(ownerRes.headers["content-security-policy"]);
  assert.match(String(ownerRes.headers["cache-control"] || ""), /no-store/);
  assert.match(String(ownerRes.headers["set-cookie"] || ""), /HttpOnly/);

  const user = createUser(app.store, {
    displayName: "TestUser",
    role: "standard",
  });
  linkExternalIdentity(app.store, {
    subject: "tu-sub",
    email: "testuser@example.com",
    userId: user.id,
  });
  const tu = await httpReq(port, "/api/status", {
    host: config.hostname,
    jwt: jwt({ email: "testuser@example.com", sub: "tu-sub" }),
  });
  assert.equal(tu.status, 200);
  assert.equal(tu.data.user.role, "standard");
  assert.equal(tu.data.identitySource, "cloudflare");
});

test("remote owner cannot switch profiles; local switch cannot bypass Cloudflare binding", async (t) => {
  const { app, port } = await appWithAccess(t);
  const owner = resolveLocalOwner(app.store);
  const target = createUser(app.store, { displayName: "LocalOnly", role: "standard" });
  const remote = { host: config.hostname, jwt: jwt() };
  const first = await httpReq(port, "/api/status", remote);
  assert.equal(first.data.user.id, owner.id);
  const denied = await httpReq(port, "/api/session/switch", {
    ...remote, token: first.data.token, method: "POST", body: { userId: target.id },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, "remote_switch_denied");
  assert.match(
    denied.data.error,
    /Local-only users cannot be switched into from a Cloudflare-authenticated session/,
  );
  assert.match(denied.data.error, /127\.0\.0\.1:3210/);
  assert.equal(denied.data.token, undefined);
  const unchanged = await httpReq(port, "/api/status", { ...remote, token: first.data.token });
  assert.equal(unchanged.data.user.id, owner.id);
  const local = await httpReq(port, "/api/status", { token: app.token });
  assert.equal(local.status, 200);
  const switched = await httpReq(port, "/api/session/switch", {
    token: local.data.token, method: "POST", body: { userId: target.id },
  });
  assert.equal(switched.status, 200);
  const localStatus = await httpReq(port, "/api/status", { token: switched.data.token });
  assert.equal(localStatus.data.user.id, target.id);
  assert.equal(localStatus.data.user.role, "standard");
  assert.equal(localStatus.data.identitySource, "local");
  const impersonation = await httpReq(port, "/api/status", { ...remote, token: switched.data.token });
  assert.equal(impersonation.status, 403);
  // Owner Cloudflare binding remains intact after a local switch elsewhere.
  const stillOwner = await httpReq(port, "/api/status", { ...remote, token: first.data.token });
  assert.equal(stillOwner.status, 200);
  assert.equal(stillOwner.data.user.id, owner.id);
  assert.equal(stillOwner.data.user.role, "owner");
  assert.equal(stillOwner.data.identitySource, "cloudflare");
});

test("role downgrade applies on next remote status", async (t) => {
  const { app, port } = await appWithAccess(t);
  const user = createUser(app.store, {
    displayName: "TestUser",
    role: "standard",
  });
  linkExternalIdentity(app.store, {
    subject: "tu2",
    email: "testuser@example.com",
    userId: user.id,
  });
  const first = await httpReq(port, "/api/status", {
    host: config.hostname,
    jwt: jwt({ email: "testuser@example.com", sub: "tu2" }),
  });
  assert.equal(first.data.user.role, "standard");
  updateUser(app.store, user.id, { role: "guest" });
  const second = await httpReq(port, "/api/status", {
    host: config.hostname,
    token: first.data.token,
    jwt: jwt({ email: "testuser@example.com", sub: "tu2" }),
  });
  assert.equal(second.data.user.role, "guest");
});

test("remote logout revokes session", async (t) => {
  const { app, port } = await appWithAccess(t);
  const owner = resolveLocalOwner(app.store);
  linkExternalIdentity(app.store, {
    subject: "owner-sub",
    email: "owner@example.com",
    userId: owner.id,
  });
  const status = await httpReq(port, "/api/status", {
    host: config.hostname,
    jwt: jwt(),
  });
  const out = await httpReq(port, "/api/session/logout", {
    host: config.hostname,
    token: status.data.token,
    jwt: jwt(),
    method: "POST",
  });
  assert.equal(out.status, 200);
  assert.equal(getSession(app.store, status.data.token), undefined);
});
