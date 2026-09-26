/**
 * Owner-controlled authorized-target registry for Security Lab.
 * Adaptive tools must use target_id. No silent destination expansion.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseHost } from "../defense/authorized.mjs";

export const TARGET_ENVIRONMENTS = Object.freeze([
  "localhost",
  "rfc1918",
  "docker",
  "vm",
  "authorized_explicit",
]);

const LOCALHOST = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLocalhostHost(host = "") {
  const h = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return LOCALHOST.has(h) || h === "0.0.0.0";
}

export function isRfc1918Host(host = "") {
  const h = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  const m = h.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

export function classifyTargetKind(host, environment) {
  if (isLocalhostHost(host)) return "localhost";
  if (environment === "docker") return "docker";
  if (environment === "vm") return "vm";
  if (isRfc1918Host(host)) return "rfc1918";
  return "authorized_explicit";
}

function asPortList(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      raw
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535),
    ),
  ];
}

function asProtocolList(value) {
  if (value == null) return ["http"];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return [
    ...new Set(
      raw
        .map((p) => String(p || "").trim().toLowerCase())
        .filter((p) => ["http", "https", "tcp", "tls", "dns"].includes(p)),
    ),
  ];
}

export function normalizeTargetRecord(input = {}, { actor, now } = {}) {
  const parsed = parseHost(input.host || input.ip || input.domain || "");
  if (!parsed?.host) {
    return { ok: false, error: "A host, IP, or domain is required." };
  }
  const environment = TARGET_ENVIRONMENTS.includes(input.environment)
    ? input.environment
    : classifyTargetKind(parsed.host, input.environment);
  const authorizationNote = String(input.authorization_note || input.authorizationNote || "").trim();
  if (!authorizationNote) {
    return {
      ok: false,
      error: "authorization_note is required. The Owner must record why this target is authorized.",
    };
  }
  const name = String(input.name || parsed.host).trim().slice(0, 80);
  if (!name) return { ok: false, error: "Target name is required." };
  return {
    ok: true,
    record: {
      target_id: String(input.target_id || input.targetId || randomUUID()),
      name,
      host: parsed.host,
      ports: asPortList(input.ports),
      protocols: asProtocolList(input.protocols),
      environment,
      authorization_note: authorizationNote,
      created_by: actor?.id || input.created_by || null,
      created_at: input.created_at || (now || new Date()).toISOString(),
      enabled: input.enabled !== false,
    },
  };
}

function assertOwner(actor) {
  if (String(actor?.role || "").toLowerCase() !== "owner") {
    const error = new Error("Only Owner can add or remove authorized lab targets.");
    error.code = "LAB_OWNER_ONLY";
    throw error;
  }
}

export function destinationsMatch(registeredHost, destination) {
  const parsed = typeof destination === "string" ? parseHost(destination) : destination;
  const host = parsed?.host || String(destination || "").toLowerCase();
  const a = String(registeredHost || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const b = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!a || !b) return false;
  return a === b;
}

export function createTargetRegistry({
  dataDirectory,
  initial = [],
  now = () => new Date(),
} = {}) {
  const file = dataDirectory
    ? path.join(dataDirectory, "security", "lab", "targets.json")
    : null;
  let targets = new Map();

  function snapshot() {
    return [...targets.values()].map((row) => ({ ...row, ports: [...row.ports], protocols: [...row.protocols] }));
  }

  async function persist() {
    if (!file) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ targets: snapshot() }, null, 2), "utf8");
  }

  async function load() {
    if (!file) return;
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      const rows = Array.isArray(raw?.targets) ? raw.targets : [];
      targets = new Map(rows.map((row) => [row.target_id, row]));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  for (const row of initial) {
    const normalized = normalizeTargetRecord(row, { now: now() });
    if (normalized.ok) targets.set(normalized.record.target_id, normalized.record);
  }

  return {
    load,
    persist,
    list({ enabledOnly = false } = {}) {
      return snapshot().filter((row) => (enabledOnly ? row.enabled : true));
    },
    get(targetId) {
      return targets.get(String(targetId || "")) || null;
    },
    require(targetId) {
      const row = this.get(targetId);
      if (!row) {
        const error = new Error(
          "Unknown target_id. Adaptive lab tests require an Owner-registered authorized target.",
        );
        error.code = "LAB_TARGET_UNKNOWN";
        throw error;
      }
      if (!row.enabled) {
        const error = new Error("Authorized target is disabled.");
        error.code = "LAB_TARGET_DISABLED";
        throw error;
      }
      return { ...row, ports: [...row.ports], protocols: [...row.protocols] };
    },
    assertDestination(targetId, destination) {
      const row = this.require(targetId);
      if (!destinationsMatch(row.host, destination)) {
        const error = new Error(
          "Destination is not the registered host for this target_id. Lab tests do not expand to unrelated hosts.",
        );
        error.code = "LAB_TARGET_MISMATCH";
        throw error;
      }
      return row;
    },
    rejectArbitrary(destination) {
      const error = new Error(
        "Arbitrary destinations are rejected. Pass target_id from the Owner authorized-target registry.",
      );
      error.code = "LAB_ARBITRARY_TARGET";
      error.destination = destination || null;
      throw error;
    },
    async add(input, actor) {
      assertOwner(actor);
      const normalized = normalizeTargetRecord(input, { actor, now: now() });
      if (!normalized.ok) {
        const error = new Error(normalized.error);
        error.code = "LAB_TARGET_INVALID";
        throw error;
      }
      targets.set(normalized.record.target_id, normalized.record);
      await persist();
      return { ...normalized.record };
    },
    async remove(targetId, actor) {
      assertOwner(actor);
      const id = String(targetId || "");
      const existed = targets.delete(id);
      await persist();
      return { removed: existed, target_id: id };
    },
    async setEnabled(targetId, enabled, actor) {
      assertOwner(actor);
      const row = this.get(targetId);
      if (!row) return { ok: false, error: "Unknown target_id." };
      row.enabled = Boolean(enabled);
      targets.set(row.target_id, row);
      await persist();
      return { ...row };
    },
  };
}
