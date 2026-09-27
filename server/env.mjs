/**
 * Load a local .env into process.env without overriding existing values.
 * Never log values. Live startup only — tests should not load the operator file.
 */
import fs from "node:fs";
import path from "node:path";

export function loadLocalEnv(root) {
  const file = path.join(root, ".env");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}
