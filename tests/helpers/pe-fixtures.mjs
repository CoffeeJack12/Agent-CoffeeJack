/**
 * Synthetic PE fixtures for tests. Not malware. Generated in memory only.
 */

export const FILE_ALIGN = 0x200;
export const SECT_ALIGN = 0x1000;
export const E_LFANEW = 0x80;
export const TIMESTAMP = 0x5f5e1000; // 2020-09-13T12:26:40.000Z

function alignUp(n, a) {
  return Math.ceil(n / a) * a;
}

export function peHeaderLayout({ pe32Plus = false, sectionCount = 1 } = {}) {
  const optSize = pe32Plus ? 0xf0 : 0xe0;
  const coffOff = E_LFANEW + 4;
  const optOff = coffOff + 20;
  const sectionOff = optOff + optSize;
  const headersEnd = sectionOff + sectionCount * 40;
  const firstRaw = alignUp(Math.max(headersEnd, FILE_ALIGN), FILE_ALIGN);
  return { eLfanew: E_LFANEW, coffOff, optOff, optSize, sectionOff, firstRaw };
}

function writeSectionName(buf, off, name) {
  const raw = Buffer.alloc(8);
  Buffer.from(String(name || "").slice(0, 8), "latin1").copy(raw);
  raw.copy(buf, off);
}

function buildImportPayload(imports, va, pe32Plus) {
  const width = pe32Plus ? 8 : 4;
  const dlls = imports || [];
  let size = (dlls.length + 1) * 20;
  const layout = [];
  for (const imp of dlls) {
    const names = imp.names || [];
    const ilt = size;
    size += (names.length + 1) * width;
    const iat = size;
    size += (names.length + 1) * width;
    const dllOff = size;
    size += Buffer.byteLength(imp.dll, "latin1") + 1;
    const hints = [];
    for (const n of names) {
      const h = size;
      size += 2 + Buffer.byteLength(n, "latin1") + 1;
      hints.push(h);
    }
    layout.push({ ilt, iat, dllOff, hints, names, dll: imp.dll });
  }
  const buf = Buffer.alloc(alignUp(size, 16));
  dlls.forEach((imp, i) => {
    const L = layout[i];
    const off = i * 20;
    buf.writeUInt32LE(va + L.ilt, off);
    buf.writeUInt32LE(0, off + 4);
    buf.writeUInt32LE(0, off + 8);
    buf.writeUInt32LE(va + L.dllOff, off + 12);
    buf.writeUInt32LE(va + L.iat, off + 16);
    buf.write(imp.dll, L.dllOff, "latin1");
    L.hints.forEach((h, n) => {
      if (pe32Plus) {
        buf.writeBigUInt64LE(BigInt(va + h), L.ilt + n * width);
        buf.writeBigUInt64LE(BigInt(va + h), L.iat + n * width);
      } else {
        buf.writeUInt32LE(va + h, L.ilt + n * width);
        buf.writeUInt32LE(va + h, L.iat + n * width);
      }
      buf.writeUInt16LE(0, h);
      buf.write(L.names[n], h + 2, "latin1");
    });
  });
  return buf;
}

function buildExportPayload(exp, va, functionRva) {
  const names = exp.names || ["Foo"];
  const dllName = exp.dllName || "demo.dll";
  let size = 40;
  const funcOff = size;
  size += names.length * 4;
  const namesOff = size;
  size += names.length * 4;
  const ordsOff = size;
  size += names.length * 2;
  const dllOff = size;
  size += Buffer.byteLength(dllName, "latin1") + 1;
  const nameOffs = [];
  for (const n of names) {
    nameOffs.push(size);
    size += Buffer.byteLength(n, "latin1") + 1;
  }
  const buf = Buffer.alloc(alignUp(size, 16));
  buf.writeUInt32LE(va + dllOff, 12);
  buf.writeUInt32LE(1, 16);
  buf.writeUInt32LE(names.length, 20);
  buf.writeUInt32LE(names.length, 24);
  buf.writeUInt32LE(va + funcOff, 28);
  buf.writeUInt32LE(va + namesOff, 32);
  buf.writeUInt32LE(va + ordsOff, 36);
  names.forEach((n, i) => {
    buf.writeUInt32LE(functionRva, funcOff + i * 4);
    buf.writeUInt32LE(va + nameOffs[i], namesOff + i * 4);
    buf.writeUInt16LE(i, ordsOff + i * 2);
    buf.write(n, nameOffs[i], "latin1");
  });
  buf.write(dllName, dllOff, "latin1");
  return buf;
}

/**
 * Build a minimal PE32 or PE32+ image.
 * @param {object} options
 */
export function buildPe({
  pe32Plus = false,
  machine,
  timeDateStamp = TIMESTAMP,
  sections,
  imports = null,
  exports = null,
  overlay = null,
  extraDirectories = {},
  packerSection = null,
} = {}) {
  const arch = machine ?? (pe32Plus ? 0x8664 : 0x014c);
  const built = [];
  const textData = Buffer.from([0xc3]);
  built.push({
    name: ".text",
    data: textData,
    characteristics: 0x60000020,
  });
  if (imports?.length) {
    built.push({
      name: ".idata",
      data: null,
      characteristics: 0xc0000040,
      kind: "imports",
    });
  }
  if (exports) {
    built.push({
      name: ".edata",
      data: null,
      characteristics: 0x40000040,
      kind: "exports",
    });
  }
  if (sections) {
    for (const s of sections) {
      if (s.name === ".text") built[0] = { ...built[0], ...s };
      else built.push(s);
    }
  }
  if (packerSection) {
    built.push({
      name: packerSection,
      data: Buffer.alloc(32, 0x90),
      characteristics: 0xe0000020,
    });
  }

  const layout = peHeaderLayout({ pe32Plus, sectionCount: built.length });
  let rawCursor = layout.firstRaw;
  let va = SECT_ALIGN;
  const realized = [];
  for (const s of built) {
    let data = s.data || Buffer.alloc(0);
    if (s.kind === "imports") data = buildImportPayload(imports, va, pe32Plus);
    if (s.kind === "exports") data = buildExportPayload(exports, va, SECT_ALIGN);
    const rawSize = alignUp(Math.max(data.length, 1), FILE_ALIGN);
    realized.push({
      ...s,
      data,
      va,
      raw: rawCursor,
      rawSize,
      virtSize: Math.max(data.length, 1),
    });
    rawCursor += rawSize;
    va += alignUp(Math.max(data.length, SECT_ALIGN), SECT_ALIGN);
  }

  let fileSize = rawCursor;
  if (overlay) fileSize += overlay.length;
  const buf = Buffer.alloc(fileSize);

  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(E_LFANEW, 0x3c);
  buf.write("PE\0\0", E_LFANEW, "latin1");

  const { coffOff, optOff, optSize, sectionOff } = layout;
  buf.writeUInt16LE(arch, coffOff);
  buf.writeUInt16LE(realized.length, coffOff + 2);
  buf.writeUInt32LE(timeDateStamp, coffOff + 4);
  buf.writeUInt16LE(optSize, coffOff + 16);
  buf.writeUInt16LE(pe32Plus ? 0x0022 : 0x0102, coffOff + 18);

  buf.writeUInt16LE(pe32Plus ? 0x20b : 0x10b, optOff);
  buf.writeUInt32LE(SECT_ALIGN, optOff + 16); // AddressOfEntryPoint
  buf.writeUInt32LE(SECT_ALIGN, optOff + 20); // BaseOfCode
  if (pe32Plus) {
    buf.writeBigUInt64LE(0x140000000n, optOff + 24);
  } else {
    buf.writeUInt32LE(0x2000, optOff + 24); // BaseOfData
    buf.writeUInt32LE(0x400000, optOff + 28);
  }
  buf.writeUInt32LE(SECT_ALIGN, optOff + 32);
  buf.writeUInt32LE(FILE_ALIGN, optOff + 36);
  buf.writeUInt16LE(6, optOff + 40);
  buf.writeUInt16LE(0, optOff + 42);
  buf.writeUInt32LE(va, optOff + 56); // SizeOfImage
  buf.writeUInt32LE(layout.firstRaw, optOff + 60);
  buf.writeUInt16LE(3, optOff + 68); // IMAGE_SUBSYSTEM_WINDOWS_CUI
  const numRvaOff = pe32Plus ? 108 : 92;
  buf.writeUInt32LE(16, optOff + numRvaOff);
  const dirOff = pe32Plus ? optOff + 112 : optOff + 96;

  const idata = realized.find((s) => s.kind === "imports");
  const edata = realized.find((s) => s.kind === "exports");
  if (edata) {
    buf.writeUInt32LE(edata.va, dirOff);
    buf.writeUInt32LE(edata.data.length, dirOff + 4);
  }
  if (idata) {
    buf.writeUInt32LE(idata.va, dirOff + 8);
    buf.writeUInt32LE(idata.data.length, dirOff + 12);
  }
  for (const [index, dir] of Object.entries(extraDirectories)) {
    const i = Number(index);
    buf.writeUInt32LE(dir.virtualAddress, dirOff + i * 8);
    buf.writeUInt32LE(dir.size, dirOff + i * 8 + 4);
  }

  realized.forEach((s, i) => {
    const off = sectionOff + i * 40;
    writeSectionName(buf, off, s.name);
    buf.writeUInt32LE(s.virtSize, off + 8);
    buf.writeUInt32LE(s.va, off + 12);
    buf.writeUInt32LE(s.rawSize, off + 16);
    buf.writeUInt32LE(s.raw, off + 20);
    buf.writeUInt32LE(s.characteristics, off + 36);
    s.data.copy(buf, s.raw);
  });

  if (overlay) overlay.copy(buf, rawCursor);
  return buf;
}

export function minimalPe32() {
  return buildPe({ pe32Plus: false });
}

export function minimalPe32Plus() {
  return buildPe({ pe32Plus: true });
}

export function peWithImports() {
  return buildPe({
    pe32Plus: false,
    imports: [{ dll: "KERNEL32.dll", names: ["ExitProcess", "LoadLibraryA"] }],
  });
}

export function peWithExports() {
  return buildPe({
    pe32Plus: false,
    exports: { dllName: "demo.dll", names: ["Foo", "Bar"] },
  });
}

export function highEntropyPe() {
  const data = Buffer.alloc(2048);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
  return buildPe({
    pe32Plus: false,
    sections: [
      {
        name: ".text",
        data,
        characteristics: 0x60000020,
      },
    ],
  });
}

export function overlayPe() {
  return buildPe({
    pe32Plus: false,
    overlay: Buffer.from("OVERLAY-DATA-FIXTURE"),
  });
}

export function packerNamedPe() {
  return buildPe({ pe32Plus: false, packerSection: "UPX0" });
}

export function truncatedPe() {
  const buf = Buffer.alloc(0x90);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(E_LFANEW, 0x3c);
  buf.write("PE\0\0", E_LFANEW, "latin1");
  return buf;
}

export function mzOnly() {
  const buf = Buffer.alloc(64);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(E_LFANEW, 0x3c);
  return buf;
}

export function badSignaturePe() {
  const buf = Buffer.alloc(0x100);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(E_LFANEW, 0x3c);
  buf.write("PX\0\0", E_LFANEW, "latin1");
  return buf;
}

export function sectionOverflowPe() {
  const pe = minimalPe32();
  const { sectionOff } = peHeaderLayout({ pe32Plus: false, sectionCount: 1 });
  pe.writeUInt32LE(0x7f000000, sectionOff + 16);
  return pe;
}

export function tinyNonPe() {
  return Buffer.from("not a pe file");
}

export function stringsFixture() {
  const ascii = [
    "HelloWorld",
    "https://example.com/path",
    "evil.example.com",
    "10.20.30.40",
    "HKLM\\Software\\CoffeeJackTest",
    "C:\\Windows\\System32\\cmd.exe",
    "kernel32.dll",
    "CreateProcessW",
    "powershell -enc AAA",
  ].join("\0");
  const utf16 = Buffer.from("WideStringURL https://wide.test/local\0", "utf16le");
  const asciiBuf = Buffer.from(ascii, "latin1");
  return Buffer.concat([utf16, Buffer.from([0, 0]), asciiBuf]);
}

export function manyStringsFixture(count = 500) {
  const parts = [];
  for (let i = 0; i < count; i++)
    parts.push(`STR${String(i).padStart(4, "0")}_UNIQUE`);
  return Buffer.from(parts.join("\0"), "latin1");
}
