#!/usr/bin/env node
/**
 * Mocked Cloudflare remote acceptance (no live tunnel required).
 * A–F local/mocked flows from the remote-readiness sprint.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAccessGuard } from "../server/access.mjs";
import { createApp } from "../server/index.mjs";
import {
  createUser,
  resolveLocalOwner,
  updateUser,
  getSession,
  disableUser,
} from "../server/users.mjs";
import {
  linkExternalIdentity,
  unlinkExternalIdentity,
} from "../server/identity.mjs";
import {
  ensureUserWorkspace,
  listWorkspacesForUser,
  userCanAccessWorkspace,
} from "../server/workspaces.mjs";
import { Tools } from "../server/tools.mjs";
import { buildEvidencePack } from "../server/council.mjs";
import { authorize } from "../server/permissions.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const config = {
  hostname: "jack.example.com",
  teamDomain: "jack-test.cloudflareaccess.com",
  audience: "c".repeat(64),
  emails: ["owner@example.com", "testuser@example.com"],
};
const clock = 1800000000000;
const key = {
  ...publicKey.export({ format: "jwk" }),
  kid: "accept-key",
  use: "sig",
};

function jwt(overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "accept-key" }),
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

function request(port, route, { host, token, jwt: assertion, method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        headers: {
          Host: host || "127.0.0.1",
          "Content-Type": "application/json",
          Connection: "close",
          ...(token ? { "X-CoffeeJack-Token": token } : {}),
          ...(assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {}),
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
            headers: res.headers,
            data,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function pass(name, detail = "") {
  console.log(`PASS ${name}${detail ? " " + detail : ""}`);
}
function fail(name, detail) {
  console.error(`FAIL ${name} — ${detail}`);
  process.exitCode = 1;
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-remote-accept-"));
  process.env.CF_ACCESS_OWNER_EMAIL = "owner@example.com";
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
        onToken("ok");
        return { role: "assistant", content: "ok", tokens: 1 };
      },
    },
  });
  app.store.set("autoGaming", false);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const port = app.server.address().port;
  const owner = resolveLocalOwner(app.store);

  try {
    // A — local owner
    const local = await request(port, "/api/status", { host: "127.0.0.1" });
    assert.equal(local.status, 200);
    assert.equal(local.data.identitySource, "local");
    assert.equal(local.data.user.role, "owner");
    assert.ok(local.data.activeWorkspace);
    pass("A LOCAL OWNER", local.data.user.display_name);

    // Tunnel markers on loopback must NOT become local owner
    const tunnelSpoof = await request(port, "/api/status", {
      host: "127.0.0.1",
      headers: {
        "Cf-Ray": "fake",
        "Cf-Connecting-IP": "1.2.3.4",
        "Cf-Access-Authenticated-User-Email": "attacker@evil.com",
      },
    });
    assert.equal(tunnelSpoof.status, 403);
    pass("A2 TUNNEL MARKERS ON LOOPBACK DENIED");

    // B — mocked Cloudflare owner maps to existing owner
    linkExternalIdentity(app.store, {
      subject: "cf-owner-sub",
      email: "owner@example.com",
      userId: owner.id,
    });
    const remoteOwner = await request(port, "/api/status", {
      host: config.hostname,
      jwt: jwt(),
    });
    assert.equal(remoteOwner.status, 200);
    assert.equal(remoteOwner.data.user.id, owner.id);
    assert.equal(remoteOwner.data.identitySource, "cloudflare");
    assert.match(String(remoteOwner.headers["set-cookie"] || ""), /coffeejack_session/);
    assert.ok(remoteOwner.headers["x-content-type-options"]);
    assert.ok(remoteOwner.headers["content-security-policy"]);
    assert.equal(remoteOwner.headers["x-frame-options"], "DENY");
    pass("B REMOTE OWNER MAPPED", "no duplicate");

    // C — TestUser isolated workspace + fix fixture
    const testUser = createUser(app.store, {
      displayName: "TestUser",
      role: "standard",
    });
    const tws = await ensureUserWorkspace(app.store, testUser.id, dir);
    linkExternalIdentity(app.store, {
      subject: "cf-testuser-sub",
      email: "testuser@example.com",
      userId: testUser.id,
    });
    const fixtureDir = tws.root_path;
    await fs.writeFile(
      path.join(fixtureDir, "math.mjs"),
      "export function add(a, b) { return a + b + 1; }\n",
    );
    await fs.writeFile(
      path.join(fixtureDir, "math.test.mjs"),
      `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './math.mjs';
test('add sums two numbers', () => assert.equal(add(2, 3), 5));
`,
    );
    await fs.writeFile(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ name: "testuser-fixture", type: "module", scripts: { test: "node --test math.test.mjs" } }),
    );

    const tuStatus = await request(port, "/api/status", {
      host: config.hostname,
      jwt: jwt({ email: "testuser@example.com", sub: "cf-testuser-sub" }),
    });
    assert.equal(tuStatus.status, 200);
    assert.equal(tuStatus.data.user.id, testUser.id);
    assert.equal(tuStatus.data.identitySource, "cloudflare");
    assert.equal(tuStatus.data.user.role, "standard");
    const ownerWs = listWorkspacesForUser(app.store, owner.id)[0];
    assert.equal(
      userCanAccessWorkspace(app.store, testUser.id, ownerWs.id),
      false,
    );
    assert.ok(
      !tuStatus.data.workspaces.some((w) => w.id === ownerWs.id),
      "owner workspace not listed",
    );

    // Tools operate only inside TestUser workspace
    const tools = new Tools({
      root: dir,
      workspace: tws.root_path,
      store: app.store,
      artifactDirectory: path.join(dir, "artifacts"),
      approve: async () => {},
    });
    await fs.mkdir(path.join(dir, "artifacts"), { recursive: true });
    const beforeOwner = await fs
      .readFile(path.join(process.cwd(), "package.json"), "utf8")
      .catch(() => null);
    await tools.execute(
      "write_file",
      {
        path: "math.mjs",
        content: "export function add(a, b) { return a + b; }\n",
      },
      AbortSignal.timeout(30000),
    );
    const testResult = await tools.execute(
      "run_tests",
      { script: "test" },
      AbortSignal.timeout(120000),
    );
    assert.equal(testResult.code, 0);
    const afterOwner = await fs
      .readFile(path.join(process.cwd(), "package.json"), "utf8")
      .catch(() => null);
    assert.equal(beforeOwner, afterOwner, "owner repo untouched");
    const pack = buildEvidencePack([
      {
        chat_id: "t1",
        tool: "write_file",
        status: "done",
        detail: JSON.stringify({ args: { path: "math.mjs" }, result: {} }),
      },
      {
        chat_id: "t1",
        tool: "run_tests",
        status: "done",
        detail: JSON.stringify({
          args: { script: "test" },
          result: { code: 0, output: "ok" },
        }),
      },
    ]);
    assert.equal(pack.tests.passed, true);
    pass("C TESTUSER WORKSPACE FIX + EVIDENCE");

    // D — owner path / IDOR denied
    const denyWs = await request(port, "/api/workspaces/active", {
      host: config.hostname,
      token: tuStatus.data.token,
      jwt: jwt({ email: "testuser@example.com", sub: "cf-testuser-sub" }),
      method: "POST",
      body: { workspaceId: ownerWs.id },
    });
    assert.equal(denyWs.status, 403);
    const denyApprove = await request(port, "/api/approve/fake-id", {
      host: config.hostname,
      token: tuStatus.data.token,
      jwt: jwt({ email: "testuser@example.com", sub: "cf-testuser-sub" }),
      method: "POST",
      body: { allow: true },
    });
    assert.equal(denyApprove.status, 404);
    pass("D TESTUSER OWNER ACCESS DENIED");

    // E — invalid tokens
    for (const overrides of [
      { exp: clock / 1000 - 5 },
      { aud: ["wrong"] },
      { iss: "https://evil.cloudflareaccess.com" },
      { email: "stranger@example.com", sub: "x" },
    ]) {
      const bad = await request(port, "/api/status", {
        host: config.hostname,
        jwt: jwt(overrides),
      });
      assert.equal(bad.status, 403);
    }
    const missing = await request(port, "/api/status", {
      host: config.hostname,
    });
    assert.equal(missing.status, 403);
    pass("E INVALID CLOUDFLARE TOKENS DENIED");

    // Logout / revoke / unlink / role downgrade
    const logout = await request(port, "/api/session/logout", {
      host: config.hostname,
      token: tuStatus.data.token,
      jwt: jwt({ email: "testuser@example.com", sub: "cf-testuser-sub" }),
      method: "POST",
    });
    assert.equal(logout.status, 200);
    assert.equal(getSession(app.store, tuStatus.data.token), undefined);

    const again = await request(port, "/api/status", {
      host: config.hostname,
      jwt: jwt({ email: "testuser@example.com", sub: "cf-testuser-sub" }),
    });
    assert.equal(again.status, 200);
    updateUser(app.store, testUser.id, { role: "guest" });
    const afterRole = await request(port, "/api/status", {
      host: config.hostname,
      token: again.data.token,
      jwt: jwt({ email: "testuser@example.com", sub: "cf-testuser-sub" }),
    });
    assert.equal(afterRole.data.user.role, "guest");
    assert.equal(
      authorize({
        user: afterRole.data.user,
        capability: "files_write",
      }).decision,
      "deny",
    );

    disableUser(app.store, testUser.id);
    const disabled = await request(port, "/api/status", {
      host: config.hostname,
      jwt: jwt({ email: "testuser@example.com", sub: "cf-testuser-sub" }),
    });
    assert.equal(disabled.status, 403);

    unlinkExternalIdentity(app.store, {
      subject: "cf-owner-sub",
      actorUserId: owner.id,
    });
    delete process.env.CF_ACCESS_OWNER_EMAIL;
    const unlinked = await request(port, "/api/status", {
      host: config.hostname,
      jwt: jwt(),
    });
    assert.equal(unlinked.status, 403);
    pass("SESSION REVOKE / ROLE / UNLINK");

    // F — gaming permission unchanged for standard/guest
    assert.equal(
      authorize({
        user: { id: "x", role: "standard", status: "active" },
        capability: "gaming_toggle",
      }).decision,
      "deny",
    );
    pass("F GAMING PERMISSION UNCHANGED");

    console.log("\nreal Cloudflare end-to-end: NOT RUN — operator credentials/setup required");
    console.log("SUMMARY mocked remote acceptance complete");
  } catch (error) {
    fail("acceptance", error.stack || error.message);
  } finally {
    delete process.env.CF_ACCESS_OWNER_EMAIL;
    app.server.closeAllConnections?.();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main();
