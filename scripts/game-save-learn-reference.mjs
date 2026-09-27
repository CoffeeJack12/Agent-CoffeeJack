/**
 * Learn a verified The Sinking City 2 infinite-ammo edit from a known
 * before/after save pair. Read-only: never writes either source file.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  learnTsc2InfiniteAmmoReference,
  parseTsc2Save,
} from "../server/game-saves/tsc2-format.mjs";
import sinkingCity2Adapter, {
  VERIFIED_INFINITE_AMMO_REFS,
} from "../server/game-saves/adapters/sinking-city-2.mjs";
import { sha256Buffer } from "../server/game-saves/hashing.mjs";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const originalPath = arg("--original");
const modifiedPath = arg("--modified");
if (!originalPath || !modifiedPath) {
  console.error("Usage: node scripts/game-save-learn-reference.mjs --original <save> --modified <save>");
  process.exit(2);
}

const original = await fs.readFile(originalPath);
const modified = await fs.readFile(modifiedPath);
const learned = learnTsc2InfiniteAmmoReference(
  parseTsc2Save(original),
  parseTsc2Save(modified),
);
const refsMatch =
  JSON.stringify(learned.refs) === JSON.stringify([...VERIFIED_INFINITE_AMMO_REFS]);

const reproduced = sinkingCity2Adapter.parse(original);
const mutation = sinkingCity2Adapter.prepareMutation(reproduced, "infinite_ammo");
const reproducedBuffer = sinkingCity2Adapter.serialize(reproduced);
const reproducedSha256 = sha256Buffer(reproducedBuffer);
const byteExactReproduction = reproducedBuffer.equals(modified);

const report = {
  ok: true,
  readOnly: true,
  original: path.basename(originalPath),
  modified: path.basename(modifiedPath),
  originalSha256: learned.originalSha256,
  modifiedSha256: learned.modifiedSha256,
  oldStashCount: learned.oldStashCount,
  newStashCount: learned.newStashCount,
  bytesAdded: learned.bytesAdded,
  learnedRefs: learned.refs,
  adapterRefsMatch: refsMatch,
  mutationAdded: mutation.added || [],
  reproducedSha256,
  byteExactReproduction,
};

console.log(JSON.stringify(report, null, 2));
if (!refsMatch || !mutation.ok || !byteExactReproduction) process.exitCode = 1;

// Keep ESM tooling happy when this file is imported by diagnostics.
export const scriptPath = fileURLToPath(import.meta.url);
