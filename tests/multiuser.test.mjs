import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/index.mjs";
import {
  ROLES,
  createSession,
  createUser,
  listUsers,
  resolveLocalOwner,
} from "../server/users.mjs";
import {
  authorize,
  canManageUsers,
  canToggleGaming,
} from "../server/permissions.mjs";
import {
  applyAutomaticMemory,
  createMemoryProposalStore,
} from "../server/auto-memory.mjs";
import { getPreferences, savePreferences } from "../server/preferences.mjs";

async function temporary(t, prefix = "coffeejack-users-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const fakeOllama = {
  models: async () => [{ name: "test" }],
  inspect: async () => ({ capabilities: ["tools"] }),
  prepare: async () => {},
  unload: async () => [],
  chat: async ({ onToken }) => {
    onToken("done");
    return { role: "assistant", content: "done", tokens: 1 };
  },
};

async function runningApp(t, ollama = fakeOllama) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coffeejack-users-http-"));
  const app = await createApp({ dataDirectory: dir, ollama });
  app.store.set("autoGaming", false);
  await new Promise((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    app,
    base: `http://127.0.0.1:${app.server.address().port}`,
  };
}

function request(base, token, route, method = "GET", body) {
  return fetch(base + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CoffeeJack-Token": token,
      Connection: "close",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("legacy migration creates owner, backfills data, and is idempotent", async (t) => {
  const dir = await temporary(t, "coffeejack-legacy-");
  const filename = path.join(dir, "coffeejack.sqlite");
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, kind TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, tool TEXT NOT NULL, detail TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE profile_preferences (profile_id TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO chats VALUES ('legacy-chat','Legacy','2026-01-01T00:00:00.000Z');
    INSERT INTO memories VALUES ('legacy-memory','Legacy note','note','2026-01-01T00:00:00.000Z');
  `);
  db.close();

  let store = new Store(dir);
  const owner = resolveLocalOwner(store);
  assert.equal(listUsers(store).length, 1);
  assert.equal(store.chat("legacy-chat").user_id, owner.id);
  assert.equal(store.memories("", owner.id)[0].user_id, owner.id);
  store.close();

  store = new Store(dir);
  assert.equal(listUsers(store).length, 1);
  assert.equal(store.chats(resolveLocalOwner(store).id).length, 1);
  store.close();
});

test("session identity ignores forged userId and isolates user data", async (t) => {
  const { app, base } = await runningApp(t);
  const owner = resolveLocalOwner(app.store);
  const other = createUser(app.store, {
    displayName: "Other",
    role: ROLES.STANDARD,
  });
  const otherToken = createSession(app.store, other.id).token;

  const chatResponse = await request(
    base,
    app.token,
    "/api/chat",
    "POST",
    { text: "owner chat", userId: other.id },
  );
  assert.equal(chatResponse.status, 200);
  const stream = (await chatResponse.text())
    .trim()
    .split("\n")
    .map(JSON.parse);
  const chatId = stream.find((item) => item.type === "chat").chat.id;

  await request(base, app.token, "/api/memories", "POST", {
    content: "owner memory",
    userId: other.id,
  });
  await request(base, app.token, "/api/preferences", "POST", {
    address: "lord",
    userId: other.id,
  });

  assert.equal(
    (
      await request(
        base,
        otherToken,
        `/api/chats/${chatId}?userId=${owner.id}`,
      )
    ).status,
    404,
  );
  assert.equal(
    (await (await request(base, otherToken, "/api/chats")).json()).length,
    0,
  );
  assert.equal(
    (await (await request(base, otherToken, "/api/memories")).json()).length,
    0,
  );
  assert.equal(
    (
      await (await request(base, otherToken, "/api/preferences")).json()
    ).preferences.address,
    "master",
  );
  assert.equal(app.store.chat(chatId).user_id, owner.id);
  assert.equal(app.store.memories("", owner.id).length, 1);
});

test("approvals can only be resolved by their owning user", async (t) => {
  let calls = 0;
  const ollama = {
    ...fakeOllama,
    chat: async () => {
      calls++;
      if (calls > 1)
        return { role: "assistant", content: "declined", tokens: 1 };
      return {
        role: "assistant",
        content: "",
        tokens: 0,
        tool_calls: [
          {
            function: {
              name: "terminal",
              arguments: { command: "Remove-Item -Force private.txt" },
            },
          },
        ],
      };
    },
  };
  const { app, base } = await runningApp(t, ollama);
  const other = createUser(app.store, {
    displayName: "Other",
    role: ROLES.STANDARD,
  });
  const otherToken = createSession(app.store, other.id).token;
  const response = await request(base, app.token, "/api/chat", "POST", {
    text: "delete private file",
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let streamed = "";
  while (!streamed.includes('"approval"')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    streamed += decoder.decode(chunk.value);
  }
  const approval = streamed
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .find((item) => item.type === "approval");
  assert.equal(
    (
      await request(
        base,
        otherToken,
        `/api/approve/${approval.id}`,
        "POST",
        { allow: true },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        base,
        app.token,
        `/api/approve/${approval.id}`,
        "POST",
        { allow: false },
      )
    ).status,
    200,
  );
  await reader.cancel();
});

test("role permissions allow, deny, and require approval", () => {
  const user = (role) => ({ id: role, role, status: "active" });
  assert.equal(
    authorize({ user: user(ROLES.OWNER), capability: "user_management" })
      .decision,
    "allow",
  );
  assert.equal(
    authorize({ user: user(ROLES.TRUSTED), capability: "git_push" }).decision,
    "require_approval",
  );
  assert.equal(
    authorize({ user: user(ROLES.STANDARD), capability: "desktop_control" })
      .decision,
    "deny",
  );
  assert.equal(
    authorize({ user: user(ROLES.GUEST), capability: "files_read" }).decision,
    "require_approval",
  );
  assert.equal(canManageUsers(user(ROLES.OWNER)), true);
  assert.equal(canManageUsers(user(ROLES.TRUSTED)), false);
  assert.equal(canToggleGaming(user(ROLES.GUEST)), false);
  assert.equal(canToggleGaming(user(ROLES.OWNER)), true);
});

test("Ask edit syncs the selected user's address preference", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coffeejack-users-ask-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const other = createUser(store, {
    displayName: "Other",
    role: ROLES.STANDARD,
  });
  savePreferences(store, { memoryBehavior: "ask" }, other.id);
  const result = applyAutomaticMemory(store, "Call me Master", {
    behavior: "ask",
    preferences: getPreferences(store, other.id),
    userId: other.id,
  });
  const proposals = createMemoryProposalStore(store);
  const [proposal] = proposals.enqueue(result.pending, null);
  proposals.resolve(proposal.id, "edit", "Address preference: Lord");
  assert.equal(getPreferences(store, other.id).address, "lord");
  assert.equal(getPreferences(store).address, "master");
});

test("guest cannot toggle gaming while owner can", async (t) => {
  const { app, base } = await runningApp(t);
  const guest = createUser(app.store, {
    displayName: "Guest",
    role: ROLES.GUEST,
  });
  const guestToken = createSession(app.store, guest.id).token;
  assert.equal(
    (
      await request(base, guestToken, "/api/gaming", "POST", {
        enabled: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(base, app.token, "/api/gaming", "POST", {
        enabled: true,
      })
    ).status,
    200,
  );
});

test("owner manages users, cannot demote last owner, and switches by token", async (t) => {
  const { app, base } = await runningApp(t);
  const createdResponse = await request(
    base,
    app.token,
    "/api/users",
    "POST",
    { displayName: "Profile", role: ROLES.STANDARD },
  );
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.role, ROLES.STANDARD);
  assert.equal(listUsers(app.store).find((u) => u.id === created.id).role, ROLES.STANDARD);
  assert.equal(
    (
      await request(
        base,
        app.token,
        `/api/users/${resolveLocalOwner(app.store).id}`,
        "PATCH",
        { role: ROLES.STANDARD },
      )
    ).status,
    409,
  );
  const switchedResponse = await request(
    base,
    app.token,
    "/api/session/switch",
    "POST",
    { userId: created.id },
  );
  assert.equal(switchedResponse.status, 200);
  const switched = await switchedResponse.json();
  assert.equal(switched.user.id, created.id);
  assert.equal(switched.user.role, ROLES.STANDARD);
  const status = await (
    await request(base, switched.token, "/api/status")
  ).json();
  assert.equal(status.user.id, created.id);
  assert.equal(status.user.role, ROLES.STANDARD);
  assert.equal(status.identitySource, "local");
  // Owner account is unchanged; switched session is standard-only.
  assert.equal(resolveLocalOwner(app.store).role, ROLES.OWNER);
  assert.equal(
    listUsers(app.store).find((u) => u.id === created.id).role,
    ROLES.STANDARD,
  );
  assert.equal((await (await request(base, switched.token, "/api/users")).json()).length, 1);
  assert.equal(
    (
      await request(
        base,
        switched.token,
        "/api/session/switch",
        "POST",
        { userId: resolveLocalOwner(app.store).id },
      )
    ).status,
    403,
  );
});

test("user creation preserves roles after reopening and requires explicit owner confirmation", async (t) => {
  const { app, base } = await runningApp(t);
  const createdIds = [];
  for (const role of [undefined, ROLES.STANDARD, ROLES.TRUSTED, ROLES.GUEST]) {
    const response = await request(base, app.token, "/api/users", "POST", {
      displayName: `Regression ${role ?? "default"}`, role,
    });
    assert.equal(response.status, 201);
    const user = await response.json();
    assert.equal(user.role, role ?? ROLES.STANDARD);
    createdIds.push([user.id, user.role]);
  }
  const before = listUsers(app.store).length;
  for (const role of ["owner", "OWNER"]) {
    for (const confirmOwner of [undefined, false, "true"]) {
      const response = await request(base, app.token, "/api/users", "POST", {
        displayName: "Accidental owner", role, confirmOwner,
      });
      assert.equal(response.status, 400);
    }
  }
  assert.equal(listUsers(app.store).length, before);
  const response = await request(base, app.token, "/api/users", "POST", {
    displayName: "Explicit owner", role: ROLES.OWNER, confirmOwner: true,
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).role, ROLES.OWNER);
  for (const [id] of createdIds) {
    const token = createSession(app.store, id).token;
    for (const role of [ROLES.STANDARD, ROLES.OWNER]) {
      assert.equal((await request(base, token, "/api/users", "POST", {
        displayName: "Unauthorized", role, confirmOwner: true,
      })).status, 403);
    }
  }
  const filename = app.store.db.prepare("PRAGMA database_list").get().file;
  const reopened = new Store(path.dirname(filename));
  try {
    for (const [id, role] of createdIds)
      assert.equal(listUsers(reopened).find((u) => u.id === id).role, role);
  } finally {
    reopened.close();
  }
});
