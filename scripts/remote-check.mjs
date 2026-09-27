#!/usr/bin/env node
/**
 * CoffeeJack remote deployment readiness check.
 * Prints PASS / WARN / FAIL — never secret values.
 */
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateAccessEnvironment } from "../server/access.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.COFFEEJACK_PORT ?? 3210);
const results = [];

function record(level, check, detail = "") {
  results.push({ level, check, detail });
  const tag = level.padEnd(4);
  console.log(`${tag}  ${check}${detail ? " — " + detail : ""}`);
}

async function canConnect(host, p, ms = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: p });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, ms);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function listeningAddresses(p) {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress`,
        ],
        { timeout: 8000 },
      );
      return stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const { stdout } = await execFileAsync(
      "sh",
      ["-c", `ss -ltn | awk '{print $4}' | grep ':${p}$' || true`],
      { timeout: 5000 },
    );
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

async function which(bin) {
  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(cmd, [bin], { timeout: 4000 });
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

async function main() {
  console.log("CoffeeJack remote readiness check\n");

  // Node
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 24) record("PASS", "Node runtime", `v${process.versions.node}`);
  else record("FAIL", "Node runtime", `need >=24, found ${process.versions.node}`);

  // Binaries
  if (await which("node")) record("PASS", "node binary available");
  else record("FAIL", "node binary available");
  if (await which("cloudflared"))
    record("PASS", "cloudflared installed (optional tunnel connector)");
  else
    record(
      "WARN",
      "cloudflared not on PATH",
      "install when provisioning the tunnel",
    );

  // Local CoffeeJack reachability
  const localUp = await canConnect("127.0.0.1", port);
  if (localUp)
    record("PASS", "CoffeeJack reachable on loopback", `127.0.0.1:${port}`);
  else
    record(
      "WARN",
      "CoffeeJack not listening yet",
      `start with npm.cmd start (expects 127.0.0.1:${port})`,
    );

  const addrs = await listeningAddresses(port);
  if (addrs.length) {
    const onlyLoopback = addrs.every(
      (a) => a === "127.0.0.1" || a === "::1" || a === "localhost",
    );
    if (onlyLoopback)
      record("PASS", "CoffeeJack bind is loopback-only", addrs.join(", "));
    else
      record(
        "FAIL",
        "CoffeeJack appears bound beyond loopback",
        addrs.join(", "),
      );
  } else if (localUp) {
    record("WARN", "Could not enumerate bind addresses", "verify listener is 127.0.0.1");
  }

  // Ollama must stay local
  const ollamaExternal =
    (await canConnect("0.0.0.0", 11434, 400)) &&
    (await listeningAddresses(11434)).some(
      (a) => a && a !== "127.0.0.1" && a !== "::1" && a !== "localhost",
    );
  const ollamaLocal = await canConnect("127.0.0.1", 11434, 600);
  if (ollamaLocal)
    record("PASS", "Ollama reachable on 127.0.0.1:11434 (not tunnelled)");
  else record("WARN", "Ollama not reachable on 127.0.0.1:11434");
  if (ollamaExternal)
    record(
      "FAIL",
      "Ollama appears externally bound",
      "keep Ollama on 127.0.0.1 only — never put it on the tunnel",
    );
  else record("PASS", "Ollama not detected on non-loopback listeners");

  // Cloudflare env (presence + format, no secret dumps)
  const access = validateAccessEnvironment(process.env);
  for (const [key, state] of Object.entries(access.summary)) {
    if (state === "missing" && access.mode !== "disabled")
      record("FAIL", key, state);
    else if (state === "optional_missing") record("WARN", key, "optional");
    else record("PASS", key, state);
  }
  if (access.mode === "disabled")
    record(
      "WARN",
      "Remote authentication",
      "disabled (local-only) — set COFFEEJACK_REMOTE_AUTH=native and COFFEEJACK_REMOTE_HOST, or the four Cloudflare Access env vars",
    );
  else if (access.mode === "ready")
    record(
      "PASS",
      access.remoteAuth === "native"
        ? "Native remote auth config"
        : "Cloudflare Access config",
      "ready",
    );
  else {
    record(
      "FAIL",
      access.remoteAuth === "native"
        ? "Native remote auth config"
        : "Cloudflare Access config",
      "incomplete",
    );
    for (const issue of access.issues) record("FAIL", "config detail", issue);
  }

  // Data / migrations (open Store to apply soft migrations, then verify)
  const dataDir = path.join(root, ".local");
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const { Store } = await import("../server/store.mjs");
    const { ensureIdentitySchema } = await import("../server/identity.mjs");
    const { ensureWorkspaceSchema } = await import("../server/workspaces.mjs");
    const store = new Store(dataDir);
    ensureIdentitySchema(store);
    ensureWorkspaceSchema(store);
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const need of [
      "users",
      "sessions",
      "external_identities",
      "workspaces",
      "workspace_memberships",
    ]) {
      if (tables.includes(need)) record("PASS", `schema table ${need}`);
      else record("FAIL", `schema table ${need}`, "missing after migration");
    }
    const chatCols = store.db.prepare("PRAGMA table_info(chats)").all();
    if (chatCols.some((c) => c.name === "workspace_id"))
      record("PASS", "chats.workspace_id migration");
    else record("FAIL", "chats.workspace_id migration", "missing");
    store.close();
    record("PASS", "SQLite database present", ".local/coffeejack.sqlite");
  } catch (error) {
    record("FAIL", "SQLite migrate/check", error.message.slice(0, 120));
  }

  // Templates present
  const template = path.join(root, "deploy", "cloudflare", "tunnel.example.yml");
  try {
    await fs.access(template);
    record("PASS", "Tunnel config template", "deploy/cloudflare/tunnel.example.yml");
  } catch {
    record("FAIL", "Tunnel config template missing");
  }

  // Credential files must not be committed
  for (const bad of [
    "deploy/cloudflare/credentials.json",
    "deploy/cloudflare/tunnel-token.txt",
    ".cloudflared/cert.pem",
  ]) {
    try {
      await fs.access(path.join(root, bad));
      record("FAIL", "Credential file in tree", bad);
    } catch {
      record("PASS", "No committed credential file", bad);
    }
  }

  console.log("\nIntended origin: http://127.0.0.1:" + port);
  console.log("Tunnel path: internet → Access → Tunnel → 127.0.0.1:" + port);
  console.log("Never tunnel Ollama (:11434).\n");

  const fails = results.filter((r) => r.level === "FAIL").length;
  const warns = results.filter((r) => r.level === "WARN").length;
  const passes = results.filter((r) => r.level === "PASS").length;
  console.log(`Summary: ${passes} PASS, ${warns} WARN, ${fails} FAIL`);
  process.exitCode = fails ? 1 : 0;
}

main().catch((error) => {
  console.error("FAIL  checker crashed —", error.message);
  process.exitCode = 1;
});
