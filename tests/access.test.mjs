import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAccessGuard, accessFromEnvironment } from "../server/access.mjs";
import { createApp } from "../server/index.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const config = {
  hostname: "jack.example.com",
  teamDomain: "jack-test.cloudflareaccess.com",
  audience: "a".repeat(64),
  emails: ["owner@example.com"],
};
const clock = 1800000000000;
const claims = {
  iss: "https://" + config.teamDomain,
  aud: [config.audience],
  exp: clock / 1000 + 300,
  email: "owner@example.com",
};
const key = {
  ...publicKey.export({ format: "jwk" }),
  kid: "test-key",
  use: "sig",
};
function token(overrides = {}, headerOverrides = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "test-key", ...headerOverrides }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ ...claims, ...overrides }),
  ).toString("base64url");
  return (
    header +
    "." +
    body +
    "." +
    sign("RSA-SHA256", Buffer.from(header + "." + body), privateKey).toString(
      "base64url",
    )
  );
}
const request = (jwt) => ({ headers: { "cf-access-jwt-assertion": jwt } });
const guard = () =>
  createAccessGuard(config, {
    now: () => clock,
    fetcher: async () => ({ ok: true, json: async () => ({ keys: [key] }) }),
  });
test("remote access is disabled by default and incomplete configuration fails closed", () => {
  assert.equal(accessFromEnvironment({}), null);
  assert.throws(
    () => accessFromEnvironment({ COFFEEJACK_REMOTE_HOST: "jack.example.com" }),
    /requires/,
  );
  assert.throws(() =>
    createAccessGuard({ ...config, teamDomain: "attacker.example" }),
  );
  assert.throws(() => createAccessGuard({ ...config, emails: [] }));
});
test("Access guard verifies signatures, expiry, audience, issuer and owner identity", async () => {
  const access = guard();
  assert.equal(await access.authorize(request(token())), true);
  for (const jwt of [
    undefined,
    "fake",
    token({ exp: 1 }),
    token({ nbf: clock / 1000 + 100 }),
    token({ aud: ["wrong"] }),
    token({ iss: "https://attacker.example" }),
    token({ email: "stranger@example.com" }),
    token({}, { alg: "none" }),
    token({}, { kid: "unknown" }),
  ])
    assert.equal(await access.authorize(request(jwt)), false);
  const signed = token();
  const parts = signed.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  assert.equal(await access.authorize(request(parts.join("."))), false);
});
test("Access signing keys are cached on demand and key-service failure denies access", async () => {
  let calls = 0;
  const access = createAccessGuard(config, {
    now: () => clock,
    fetcher: async () => {
      calls++;
      return { ok: true, json: async () => ({ keys: [key] }) };
    },
  });
  await Promise.all([
    access.authorize(request(token())),
    access.authorize(request(token())),
  ]);
  assert.equal(calls, 1);
  const offline = createAccessGuard(config, {
    now: () => clock,
    fetcher: async () => {
      throw Error("offline");
    },
  });
  assert.equal(await offline.authorize(request(token())), false);
});
test("remote HTTP protects reads and preserves session-token and origin checks", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-access-"));
  const app = await createApp({
    dataDirectory: dir,
    remoteAccess: guard(),
    ollama: { models: async () => [] },
  });
  app.store.set("autoGaming", false);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const send = (headers = {}, method = "GET", route = "/api/status") =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: app.server.address().port,
          path: route,
          method,
          headers: { Host: config.hostname, ...headers },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(
        method === "POST" ? JSON.stringify({ content: "hello" }) : undefined,
      );
    });
  assert.equal(await send(), 403);
  assert.equal(await send({}, "GET", "/"), 403);
  const auth = { "Cf-Access-Jwt-Assertion": token() };
  assert.equal(await send(auth), 403);
  assert.equal(
    await send({ ...auth, "X-CoffeeJack-Token": app.token }),
    200,
  );
  assert.equal(
    await send({ ...auth, Origin: "https://attacker.example" }),
    403,
  );
  assert.equal(await send({ ...auth, "Sec-Fetch-Site": "cross-site" }), 403);
  assert.equal(await send(auth, "POST", "/api/memories"), 403);
  assert.equal(
    await send(
      {
        ...auth,
        Origin: "https://" + config.hostname,
        "X-CoffeeJack-Token": app.token,
      },
      "POST",
      "/api/memories",
    ),
    200,
  );
  assert.equal(await send({ Host: "evil.example", ...auth }), 403);
});
