/**
 * Static browser modules referenced by the main app must be served (not 404).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");

function moduleImportsFrom(source) {
  const found = new Set();
  const re = /from\s+["'](\/[^"']+)["']/g;
  let match;
  while ((match = re.exec(source))) found.add(match[1]);
  return [...found];
}

test("every JS module imported by public/app.js is served at HTTP 200", async (t) => {
  const appJs = await fs.readFile(path.join(publicDir, "app.js"), "utf8");
  const imports = moduleImportsFrom(appJs);
  assert.ok(imports.includes("/chat-visibility.js"));
  assert.ok(imports.length >= 5, "expected several app module imports");

  for (const route of imports) {
    const onDisk = path.join(publicDir, route.slice(1));
    await fs.access(onDisk);
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jack-static-"));
  const app = await createApp({
    dataDirectory: dir,
    ollama: {
      models: async () => [],
      unload: async () => [],
    },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const route of ["/app.js", ...imports]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, `${route} must be served`);
    const type = response.headers.get("content-type") || "";
    assert.match(type, /javascript|ecmascript/i, `${route} content-type`);
  }
});
