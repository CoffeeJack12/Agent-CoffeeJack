import fs from "node:fs/promises";
import path from "node:path";
import { workspacePath } from "./files.mjs";

export async function projectMap(workspace, signal) {
  const base = await fs.realpath(workspace);
  const entries = [];
  let limited = false;
  async function walk(directory, depth) {
    signal?.throwIfAborted();
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const name = item.name.toLowerCase().replace(/[ .]+$/, "");
      if (
        [".git", ".env", ".local", "node_modules"].includes(name) ||
        name.startsWith(".env.")
      )
        continue;
      const relative = path.relative(base, path.join(directory, item.name));
      let full;
      try {
        full = await workspacePath(base, relative);
        if ((await fs.lstat(full)).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      entries.push({
        path: relative.split(path.sep).join("/"),
        directory: item.isDirectory(),
      });
      if (entries.length >= 200) {
        limited = true;
        return;
      }
      if (item.isDirectory()) {
        if (depth < 3) {
          await walk(full, depth + 1);
          if (limited) return;
        } else limited = true;
      }
    }
  }
  await walk(base, 0);
  const scripts = await projectScripts(base);
  return { entries, limited, scripts, untrusted: true };
}

export async function projectScripts(workspace) {
  let file;
  try {
    file = await workspacePath(workspace, "package.json");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  if ((await fs.stat(file)).size > 100000)
    throw new Error("package.json is too large");
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  return Object.fromEntries(
    ["test", "build", "lint", "check"]
      .filter((key) => typeof data.scripts?.[key] === "string")
      .map((key) => [key, data.scripts[key].slice(0, 1000)]),
  );
}

export function patchText(content, oldText, newText) {
  if (typeof oldText !== "string" || !oldText || typeof newText !== "string")
    throw new Error("A patch requires nonempty oldText and string newText");
  const position = content.indexOf(oldText);
  if (position < 0)
    throw new Error("Patch context no longer matches. Read the file again.");
  if (content.indexOf(oldText, position + 1) >= 0)
    throw new Error(
      "Patch context is ambiguous. Include more surrounding text.",
    );
  const result =
    content.slice(0, position) +
    newText +
    content.slice(position + oldText.length);
  if (result.length > 500000)
    throw new Error("Patched file must be under 500 KB");
  return result;
}
