import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function sha256File(filePath) {
  return sha256Buffer(await fs.readFile(filePath));
}

export function hashesEqual(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.length === 64 &&
    a.toLowerCase() === b.toLowerCase()
  );
}
