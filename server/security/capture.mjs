/**
 * Owner-only packet capture. Metadata by default. Never committed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { detectSecurityTools } from "./detect.mjs";
import { securityResult } from "./evidence.mjs";

export const DEFAULT_CAPTURE_SECONDS = 60;
export const HARD_MAX_CAPTURE_SECONDS = 600;

function clampDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return DEFAULT_CAPTURE_SECONDS;
  return Math.min(HARD_MAX_CAPTURE_SECONDS, Math.max(1, Math.floor(n)));
}

export function createCaptureStore({
  dataDirectory,
  exists,
  runner,
  clock = () => Date.now(),
} = {}) {
  const sessions = new Map();

  function userDir(userId) {
    return path.join(dataDirectory, "security", "captures", String(userId));
  }

  return {
    async start({
      userId,
      durationSeconds = DEFAULT_CAPTURE_SECONDS,
      includePayload = false,
      processId = null,
    } = {}) {
      const detected = detectSecurityTools({ exists });
      const engine = detected.pktmon
        ? "pktmon"
        : detected.tshark
          ? "tshark"
          : null;
      if (!engine) {
        return securityResult({
          tool: "security_packet_capture",
          available: false,
          error: "Neither pktmon nor tshark is installed.",
          observed: { pktmon: false, tshark: false },
        });
      }
      const duration = clampDuration(durationSeconds);
      const id = randomUUID();
      const dir = userDir(userId);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${id}.json`);
      const record = {
        id,
        userId,
        engine,
        includePayload: Boolean(includePayload),
        processId,
        durationSeconds: duration,
        startedAt: new Date(clock()).toISOString(),
        status: "running",
        packets: [],
      };
      if (typeof runner === "function") {
        const captured = await runner({
          engine,
          durationSeconds: duration,
          includePayload: Boolean(includePayload),
          processId,
        });
        record.packets = (captured.packets || []).slice(0, 400).map((p) => {
          const meta = {
            timestamp: p.timestamp,
            source: p.source,
            destination: p.destination,
            protocol: p.protocol,
            sourcePort: p.sourcePort,
            destinationPort: p.destinationPort,
            size: p.size,
          };
          if (includePayload) meta.payload = p.payload || null;
          return meta;
        });
        record.status = "stopped";
        record.stoppedAt = new Date(clock()).toISOString();
      }
      sessions.set(id, record);
      await fs.writeFile(file, JSON.stringify(record, null, 2));
      return securityResult({
        tool: "security_packet_capture",
        available: true,
        observed: {
          captureId: id,
          engine,
          includePayload: Boolean(includePayload),
          durationSeconds: duration,
          processId,
          file,
          packetCount: record.packets.length,
          status: record.status,
        },
        unverified: includePayload
          ? ["Full-payload mode stores packet contents locally only."]
          : ["Metadata-only capture. Payloads were not stored."],
      });
    },

    async stop({ userId, captureId }) {
      const record = sessions.get(captureId);
      if (!record || record.userId !== userId) {
        return securityResult({
          tool: "security_packet_capture",
          error: "Capture not found for this user.",
          observed: { captureId },
        });
      }
      record.status = "stopped";
      record.stoppedAt = new Date(clock()).toISOString();
      await fs.writeFile(
        path.join(userDir(userId), `${captureId}.json`),
        JSON.stringify(record, null, 2),
      );
      return securityResult({
        tool: "security_packet_capture",
        observed: {
          captureId,
          status: "stopped",
          packetCount: record.packets.length,
        },
      });
    },

    async inspect({ userId, captureId }) {
      const file = path.join(userDir(userId), `${captureId}.json`);
      let record = sessions.get(captureId);
      if (!record) {
        try {
          record = JSON.parse(await fs.readFile(file, "utf8"));
        } catch {
          return securityResult({
            tool: "security_packet_capture",
            error: "Capture not found for this user.",
            observed: { captureId },
          });
        }
      }
      if (record.userId !== userId) {
        return securityResult({
          tool: "security_packet_capture",
          error: "Capture not found for this user.",
          observed: { captureId },
        });
      }
      const packets = (record.packets || []).map((p) => {
        const copy = { ...p };
        if (!record.includePayload) delete copy.payload;
        return copy;
      });
      return securityResult({
        tool: "security_packet_capture",
        observed: {
          captureId,
          engine: record.engine,
          includePayload: Boolean(record.includePayload),
          status: record.status,
          packets,
        },
      });
    },

    async delete({ userId, captureId }) {
      sessions.delete(captureId);
      const file = path.join(userDir(userId), `${captureId}.json`);
      await fs.rm(file, { force: true });
      return securityResult({
        tool: "security_packet_capture",
        observed: { captureId, deleted: true },
      });
    },
  };
}
