/**
 * Artifact ownership / isolation — session authz, workspace membership,
 * path confinement, legacy migration, and owned-only cleanup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import {
  createSession,
  createUser,
  resolveLocalOwner,
  revokeSession,
  disableUser,
} from "../server/users.mjs";
import {
  ensureUserWorkspace,
  listWorkspacesForUser,
} from "../server/workspaces.mjs";
import {
  registerArtifact,
  getArtifactByName,
  authorizeArtifactRead,
  cleanupArtifacts,
  migrateLegacyArtifacts,
  ensureArtifactSchema,
  ensureScopedArtifactDir,
  artifactRelativePath,
  isSafeArtifactName,
} from "../server/artifacts.mjs";

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-art-"));
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
  return {
    app,
    dir,
    port: app.server.address().port,
  };
}

function req(port, route, { token = "", method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        headers: {
          Host: "127.0.0.1",
          "Content-Type": "application/json",
          "X-CoffeeJack-Token": token,
          Connection: "close",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks),
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function seedScopedArtifact(app, { userId, workspaceId, name, bytes }) {
  const dir = await ensureScopedArtifactDir(
    app.artifactsDirectory,
    userId,
    workspaceId,
  );
  const absolute = path.join(dir, name);
  await fs.writeFile(absolute, bytes || Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  registerArtifact(app.store, {
    name,
    userId,
    workspaceId,
    relativePath: artifactRelativePath(userId, workspaceId, name),
  });
  return absolute;
}

test("owner can access own artifact", async (t) => {
  const { app, port } = await localApp(t);
  const owner = resolveLocalOwner(app.store);
  const ws = listWorkspacesForUser(app.store, owner.id)[0];
  const name = `browser-${Date.now()}.png`;
  await seedScopedArtifact(app, {
    userId: owner.id,
    workspaceId: ws.id,
    name,
  });
  const ok = await req(port, `/artifacts/${name}`, { token: app.token });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.length >= 4);
});

test("UserA can access own artifact; cannot access UserB or owner", async (t) => {
  const { app, port, dir } = await localApp(t);
  const owner = resolveLocalOwner(app.store);
  const ownerWs = listWorkspacesForUser(app.store, owner.id)[0];
  const userA = createUser(app.store, { displayName: "UserA", role: "standard" });
  const userB = createUser(app.store, { displayName: "UserB", role: "standard" });
  await ensureUserWorkspace(app.store, userA.id, dir);
  await ensureUserWorkspace(app.store, userB.id, dir);
  const wsA = listWorkspacesForUser(app.store, userA.id)[0];
  const wsB = listWorkspacesForUser(app.store, userB.id)[0];
  const tokenA = createSession(app.store, userA.id).token;
  const tokenB = createSession(app.store, userB.id).token;

  const nameA = `browser-${Date.now()}1.png`;
  const nameB = `browser-${Date.now()}2.png`;
  const nameO = `desktop-${Date.now()}3.png`;
  await seedScopedArtifact(app, {
    userId: userA.id,
    workspaceId: wsA.id,
    name: nameA,
  });
  await seedScopedArtifact(app, {
    userId: userB.id,
    workspaceId: wsB.id,
    name: nameB,
  });
  await seedScopedArtifact(app, {
    userId: owner.id,
    workspaceId: ownerWs.id,
    name: nameO,
  });

  assert.equal(
    (await req(port, `/artifacts/${nameA}`, { token: tokenA })).status,
    200,
  );
  assert.equal(
    (await req(port, `/artifacts/${nameB}`, { token: tokenA })).status,
    403,
  );
  assert.equal(
    (await req(port, `/artifacts/${nameO}`, { token: tokenA })).status,
    403,
  );
  assert.equal(
    (await req(port, `/artifacts/${nameB}`, { token: tokenB })).status,
    200,
  );
});

test("forged workspace or artifact id is denied", async (t) => {
  const { app, port, dir } = await localApp(t);
  const userA = createUser(app.store, { displayName: "ForgeA", role: "standard" });
  await ensureUserWorkspace(app.store, userA.id, dir);
  const tokenA = createSession(app.store, userA.id).token;
  const ownerId = resolveLocalOwner(app.store).id;
  assert.equal(
    (
      await req(
        port,
        `/artifacts/browser-9999999999999.png?workspaceId=forged&userId=${encodeURIComponent(ownerId)}`,
        { token: tokenA },
      )
    ).status,
    404,
  );
});

test("path traversal is denied", async (t) => {
  const { app, port } = await localApp(t);
  for (const bad of [
    "/artifacts/../coffeejack.sqlite",
    "/artifacts/..%2Fcoffeejack.sqlite",
    "/artifacts/browser-1.png/../../coffeejack.sqlite",
    "/artifacts/%2e%2e/coffeejack.sqlite",
  ]) {
    const res = await req(port, bad, { token: app.token });
    assert.ok(
      res.status === 403 || res.status === 404,
      `${bad} => ${res.status}`,
    );
  }
  assert.equal(isSafeArtifactName("../browser-1.png"), false);
  assert.equal(isSafeArtifactName("C:\\Windows\\browser-1.png"), false);
});

test("unauthenticated, revoked, and disabled sessions are denied", async (t) => {
  const { app, port, dir } = await localApp(t);
  const owner = resolveLocalOwner(app.store);
  const ws = listWorkspacesForUser(app.store, owner.id)[0];
  const name = `browser-${Date.now()}.png`;
  await seedScopedArtifact(app, {
    userId: owner.id,
    workspaceId: ws.id,
    name,
  });

  assert.equal((await req(port, `/artifacts/${name}`)).status, 403);

  const session = createSession(app.store, owner.id);
  revokeSession(app.store, session.token);
  assert.equal(
    (await req(port, `/artifacts/${name}`, { token: session.token })).status,
    403,
  );

  const temp = createUser(app.store, { displayName: "TempArt", role: "standard" });
  await ensureUserWorkspace(app.store, temp.id, dir);
  const tempWs = listWorkspacesForUser(app.store, temp.id)[0];
  const tempName = `desktop-${Date.now()}.png`;
  await seedScopedArtifact(app, {
    userId: temp.id,
    workspaceId: tempWs.id,
    name: tempName,
  });
  const tempToken = createSession(app.store, temp.id).token;
  disableUser(app.store, temp.id);
  assert.equal(
    (await req(port, `/artifacts/${tempName}`, { token: tempToken })).status,
    403,
  );
});

test("legacy flat artifacts migrate to owner and stay owner-only", async (t) => {
  const dir = await tempDir(t);
  const artifacts = path.join(dir, "artifacts");
  await fs.mkdir(artifacts, { recursive: true });
  const legacyName = `browser-${Date.now()}.png`;
  await fs.writeFile(
    path.join(artifacts, legacyName),
    Buffer.from([137, 80, 78, 71, 9, 9, 9]),
  );

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

  const row = getArtifactByName(app.store, legacyName);
  assert.ok(row, "legacy file registered");
  const owner = resolveLocalOwner(app.store);
  assert.equal(row.user_id, owner.id);
  assert.ok(
    !(await fs
      .access(path.join(artifacts, legacyName))
      .then(() => true)
      .catch(() => false)),
    "flat file moved out of root",
  );

  // Idempotent second pass
  const again = await migrateLegacyArtifacts(app.store, artifacts, {
    root: dir,
  });
  assert.equal(again.migrated, 0);

  assert.equal(
    (await req(port, `/artifacts/${legacyName}`, { token: app.token })).status,
    200,
  );

  const other = createUser(app.store, {
    displayName: "NoLegacy",
    role: "standard",
  });
  await ensureUserWorkspace(app.store, other.id, dir);
  const otherToken = createSession(app.store, other.id).token;
  assert.equal(
    (await req(port, `/artifacts/${legacyName}`, { token: otherToken })).status,
    403,
  );
});

test("cleanup never deletes another user's artifacts", async (t) => {
  const { app, dir } = await localApp(t);
  const owner = resolveLocalOwner(app.store);
  const ownerWs = listWorkspacesForUser(app.store, owner.id)[0];
  const userA = createUser(app.store, { displayName: "CleanA", role: "standard" });
  await ensureUserWorkspace(app.store, userA.id, dir);
  const wsA = listWorkspacesForUser(app.store, userA.id)[0];

  const nameO = `browser-${Date.now()}0.png`;
  const nameA = `browser-${Date.now()}1.png`;
  const pathO = await seedScopedArtifact(app, {
    userId: owner.id,
    workspaceId: ownerWs.id,
    name: nameO,
  });
  const pathA = await seedScopedArtifact(app, {
    userId: userA.id,
    workspaceId: wsA.id,
    name: nameA,
  });

  // UserA tries to clean owner's name via names list — must no-op for foreign rows
  const cleaned = await cleanupArtifacts(app.store, app.artifactsDirectory, {
    actorUserId: userA.id,
    names: [nameO, nameA],
  });
  assert.equal(cleaned.removed, 1);
  assert.ok(getArtifactByName(app.store, nameO));
  assert.equal(getArtifactByName(app.store, nameA), undefined);
  await assert.doesNotReject(fs.access(pathO));
  await assert.rejects(fs.access(pathA));
});

test("authorizeArtifactRead rejects cross-user and missing files", async (t) => {
  const { app, dir } = await localApp(t);
  ensureArtifactSchema(app.store);
  const owner = resolveLocalOwner(app.store);
  const ownerWs = listWorkspacesForUser(app.store, owner.id)[0];
  const userA = createUser(app.store, { displayName: "AuthzA", role: "standard" });
  await ensureUserWorkspace(app.store, userA.id, dir);
  const name = `browser-${Date.now()}.png`;
  await seedScopedArtifact(app, {
    userId: owner.id,
    workspaceId: ownerWs.id,
    name,
  });
  await assert.rejects(
    () =>
      authorizeArtifactRead(app.store, app.artifactsDirectory, {
        name,
        userId: userA.id,
      }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    () =>
      authorizeArtifactRead(app.store, app.artifactsDirectory, {
        name: "browser-0.png",
        userId: owner.id,
      }),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () =>
      authorizeArtifactRead(app.store, app.artifactsDirectory, {
        name: "../secret.png",
        userId: owner.id,
      }),
    (e) => e.status === 404,
  );
});
