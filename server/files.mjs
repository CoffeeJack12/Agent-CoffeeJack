import fs from "node:fs/promises";
import path from "node:path";

// Both lexical and real paths are checked to prevent symlink/junction escapes.
export async function workspacePath(root, input = ".", { write = false } = {}) {
  if (
    typeof input !== "string" ||
    input.includes("\0") ||
    input.includes(":") ||
    path.isAbsolute(input)
  )
    throw new Error("Use a relative workspace path.");
  const base = await fs.realpath(root);
  const target = path.resolve(base, input);
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("Path is outside the workspace.");
  if (
    rel.split(/[\\/]/).some((part) => {
      const p = part.toLowerCase().replace(/[ .]+$/, "");
      return (
        p === ".git" ||
        p === ".env" ||
        p.startsWith(".env.") ||
        p === "node_modules"
      );
    })
  )
    throw new Error("Protected path.");
  let existing = target;
  while (true) {
    try {
      const real = await fs.realpath(existing);
      const r = path.relative(base, real);
      if (r.startsWith("..") || path.isAbsolute(r))
        throw new Error("Link points outside the workspace.");
      break;
    } catch (e) {
      if (e.code !== "ENOENT" || !write || existing === base) throw e;
      existing = path.dirname(existing);
    }
  }
  return target;
}

export async function readDocument(filename) {
  const stat = await fs.stat(filename);
  if (stat.size > 20 * 1024 * 1024)
    throw new Error("File is too large (20 MB maximum).");
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await getDocument({
      data: new Uint8Array(await fs.readFile(filename)),
      useSystemFonts: true,
      isEvalSupported: false,
    }).promise;
    try {
      const pages = [];
      for (let i = 1; i <= Math.min(doc.numPages, 80); i++)
        pages.push(
          (await (await doc.getPage(i)).getTextContent()).items
            .map((v) => v.str)
            .join(" "),
        );
      return pages.join("\n").slice(0, 80000);
    } finally {
      await doc.destroy();
    }
  }
  if (ext === ".docx") {
    const { default: mammoth } = await import("mammoth");
    return (await mammoth.extractRawText({ path: filename })).value.slice(
      0,
      80000,
    );
  }
  if (ext === ".xlsx") {
    const { default: ExcelJS } = await import("exceljs");
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(filename);
    const lines = [];
    book.eachSheet((s) => {
      lines.push(`Sheet: ${s.name}`);
      s.eachRow((r, n) => {
        if (n <= 1000) lines.push(JSON.stringify(r.values));
      });
    });
    return lines.join("\n").slice(0, 80000);
  }
  if (
    [".png", ".jpg", ".jpeg", ".webp", ".gif", ".exe", ".dll", ".zip"].includes(
      ext,
    )
  )
    throw new Error("Binary file: attach images to chat with a vision model.");
  return (await fs.readFile(filename, "utf8")).slice(0, 80000);
}
