/**
 * Bounded PE32 / PE32+ parser. Fail-closed. Never executes the file.
 */

const MAX_SECTIONS = 96;
const MAX_IMPORT_DLLS = 512;
const MAX_IMPORT_NAMES = 4096;
const MAX_EXPORTS = 4096;
const MAX_STRING = 512;

export class PeParseError extends Error {
  constructor(message, code = "PE_PARSE") {
    super(message);
    this.name = "PeParseError";
    this.code = code;
  }
}

function check(buf, offset, length, label = "range") {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buf.length
  ) {
    throw new PeParseError(
      `Bounds violation reading ${label} at ${offset}+${length} (file ${buf.length})`,
      "PE_BOUNDS",
    );
  }
}

function u8(buf, off) {
  check(buf, off, 1, "u8");
  return buf[off];
}
function u16(buf, off) {
  check(buf, off, 2, "u16");
  return buf.readUInt16LE(off);
}
function u32(buf, off) {
  check(buf, off, 4, "u32");
  return buf.readUInt32LE(off);
}
function u64(buf, off) {
  check(buf, off, 8, "u64");
  return buf.readBigUInt64LE(off);
}

function asciiZ(buf, off, max = MAX_STRING) {
  check(buf, off, 1, "ascii");
  let end = off;
  const limit = Math.min(buf.length, off + max);
  while (end < limit && buf[end] !== 0) end++;
  return buf.subarray(off, end).toString("latin1");
}

function asciiFixed(buf, off, len) {
  check(buf, off, len, "ascii-fixed");
  let end = off + len;
  while (end > off && buf[end - 1] === 0) end--;
  return buf.subarray(off, end).toString("latin1").replace(/\0/g, "");
}

const MACHINES = {
  0x014c: "I386",
  0x8664: "AMD64",
  0xaa64: "ARM64",
  0x01c0: "ARM",
  0x01c4: "ARMNT",
  0x0200: "IA64",
};

export function rvaToOffset(sections, rva) {
  if (!Number.isFinite(rva) || rva < 0) return null;
  for (const s of sections) {
    const start = s.virtualAddress;
    const span = Math.max(s.virtualSize || 0, s.sizeOfRawData || 0);
    if (rva >= start && rva < start + span) {
      const delta = rva - start;
      if (s.pointerToRawData === 0 && s.sizeOfRawData === 0) return null;
      return s.pointerToRawData + delta;
    }
  }
  return null;
}

function parseDataDirectories(buf, start, count) {
  const dirs = [];
  const n = Math.min(count, 16);
  for (let i = 0; i < n; i++) {
    const off = start + i * 8;
    dirs.push({
      virtualAddress: u32(buf, off),
      size: u32(buf, off + 4),
    });
  }
  return dirs;
}

function parseSections(buf, start, count) {
  if (count > MAX_SECTIONS)
    throw new PeParseError(`Too many sections: ${count}`, "PE_BOUNDS");
  const sections = [];
  for (let i = 0; i < count; i++) {
    const off = start + i * 40;
    check(buf, off, 40, "section");
    const chars = u32(buf, off + 36);
    const pointerToRawData = u32(buf, off + 20);
    const sizeOfRawData = u32(buf, off + 16);
    if (pointerToRawData || sizeOfRawData) {
      if (pointerToRawData > buf.length || pointerToRawData + sizeOfRawData > buf.length)
        throw new PeParseError(
          `Section raw data exceeds file (${pointerToRawData}+${sizeOfRawData})`,
          "PE_BOUNDS",
        );
    }
    sections.push({
      name: asciiFixed(buf, off, 8),
      virtualSize: u32(buf, off + 8),
      virtualAddress: u32(buf, off + 12),
      sizeOfRawData,
      pointerToRawData,
      characteristics: chars,
      permissions: {
        execute: Boolean(chars & 0x20000000),
        read: Boolean(chars & 0x40000000),
        write: Boolean(chars & 0x80000000),
      },
    });
  }
  return sections;
}

function parseImports(buf, sections, directory, pe32Plus) {
  if (!directory?.virtualAddress || !directory.size) return [];
  const start = rvaToOffset(sections, directory.virtualAddress);
  if (start == null)
    throw new PeParseError("Import directory RVA is outside sections", "PE_BOUNDS");
  const imports = [];
  let names = 0;
  for (let i = 0; i < MAX_IMPORT_DLLS; i++) {
    const off = start + i * 20;
    check(buf, off, 20, "import-desc");
    const originalFirstThunk = u32(buf, off);
    const nameRva = u32(buf, off + 12);
    const firstThunk = u32(buf, off + 16);
    if (!originalFirstThunk && !nameRva && !firstThunk) break;
    const nameOff = rvaToOffset(sections, nameRva);
    if (nameOff == null)
      throw new PeParseError("Import DLL name RVA is out of bounds", "PE_BOUNDS");
    const dll = asciiZ(buf, nameOff);
    const thunkRva = originalFirstThunk || firstThunk;
    const thunkOff = rvaToOffset(sections, thunkRva);
    const apis = [];
    if (thunkOff != null) {
      const width = pe32Plus ? 8 : 4;
      for (let t = 0; t < MAX_IMPORT_NAMES; t++) {
        const toff = thunkOff + t * width;
        const raw = pe32Plus ? u64(buf, toff) : BigInt(u32(buf, toff));
        if (raw === 0n) break;
        names++;
        if (names > MAX_IMPORT_NAMES)
          throw new PeParseError("Too many import names", "PE_BOUNDS");
        const ordinalBit = pe32Plus ? 0x8000000000000000n : 0x80000000n;
        if (raw & ordinalBit) {
          apis.push({ ordinal: Number(raw & 0xffffn) });
        } else {
          const hintRva = Number(raw & 0xffffffffn);
          const hintOff = rvaToOffset(sections, hintRva);
          if (hintOff == null)
            throw new PeParseError("Import name RVA is out of bounds", "PE_BOUNDS");
          check(buf, hintOff, 2, "import-hint");
          apis.push({ hint: u16(buf, hintOff), name: asciiZ(buf, hintOff + 2) });
        }
      }
    }
    imports.push({ dll, apis: apis.slice(0, 256) });
  }
  return imports;
}

function parseExports(buf, sections, directory) {
  if (!directory?.virtualAddress || !directory.size) return { dllName: null, names: [] };
  const start = rvaToOffset(sections, directory.virtualAddress);
  if (start == null)
    throw new PeParseError("Export directory RVA is outside sections", "PE_BOUNDS");
  check(buf, start, 40, "export-dir");
  const nameRva = u32(buf, start + 12);
  const numberOfNames = u32(buf, start + 24);
  const namesRva = u32(buf, start + 32);
  const ordinalsRva = u32(buf, start + 36);
  const functionsRva = u32(buf, start + 28);
  const base = u32(buf, start + 16);
  if (numberOfNames > MAX_EXPORTS)
    throw new PeParseError("Too many exports", "PE_BOUNDS");
  const dllOff = nameRva ? rvaToOffset(sections, nameRva) : null;
  const dllName = dllOff != null ? asciiZ(buf, dllOff) : null;
  const namesOff = namesRva ? rvaToOffset(sections, namesRva) : null;
  const ordsOff = ordinalsRva ? rvaToOffset(sections, ordinalsRva) : null;
  const funcsOff = functionsRva ? rvaToOffset(sections, functionsRva) : null;
  const names = [];
  if (namesOff != null) {
    for (let i = 0; i < numberOfNames; i++) {
      const nrva = u32(buf, namesOff + i * 4);
      const noff = rvaToOffset(sections, nrva);
      if (noff == null)
        throw new PeParseError("Export name RVA is out of bounds", "PE_BOUNDS");
      const ordinal =
        ordsOff != null ? u16(buf, ordsOff + i * 2) + base : null;
      const rva =
        funcsOff != null && ordsOff != null
          ? u32(buf, funcsOff + u16(buf, ordsOff + i * 2) * 4)
          : null;
      names.push({ name: asciiZ(buf, noff), ordinal, rva });
    }
  }
  return { dllName, names, numberOfNames, base };
}

function directoryPresent(dir) {
  return Boolean(dir && dir.virtualAddress && dir.size);
}

export function parsePe(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 64)
    throw new PeParseError("File too small for a DOS header", "PE_PARSE");
  if (u16(buf, 0) !== 0x5a4d)
    throw new PeParseError("Missing MZ DOS signature", "PE_PARSE");
  const eLfanew = u32(buf, 0x3c);
  if (eLfanew < 64)
    throw new PeParseError("Invalid e_lfanew", "PE_BOUNDS");
  check(buf, eLfanew, 24, "pe-signature+coff");
  if (buf.toString("latin1", eLfanew, eLfanew + 4) !== "PE\0\0")
    throw new PeParseError("Missing PE signature", "PE_PARSE");
  const coffOff = eLfanew + 4;
  const machine = u16(buf, coffOff);
  const numberOfSections = u16(buf, coffOff + 2);
  const timeDateStamp = u32(buf, coffOff + 4);
  const sizeOfOptionalHeader = u16(buf, coffOff + 16);
  const characteristics = u16(buf, coffOff + 18);
  const optOff = coffOff + 20;
  if (sizeOfOptionalHeader < 2)
    throw new PeParseError("Optional header missing", "PE_PARSE");
  check(buf, optOff, sizeOfOptionalHeader, "optional-header");
  const magic = u16(buf, optOff);
  const pe32Plus = magic === 0x20b;
  if (magic !== 0x10b && magic !== 0x20b)
    throw new PeParseError(`Unknown optional-header magic 0x${magic.toString(16)}`, "PE_PARSE");
  const addressOfEntryPoint = u32(buf, optOff + 16);
  const imageBase = pe32Plus ? u64(buf, optOff + 24) : BigInt(u32(buf, optOff + 28));
  const numberOfRvaAndSizes = pe32Plus
    ? u32(buf, optOff + 108)
    : u32(buf, optOff + 92);
  const dirOff = pe32Plus ? optOff + 112 : optOff + 96;
  const directories = parseDataDirectories(buf, dirOff, numberOfRvaAndSizes);
  const sectionOff = optOff + sizeOfOptionalHeader;
  const sections = parseSections(buf, sectionOff, numberOfSections);
  let lastRawEnd = 0;
  for (const s of sections) {
    const end = (s.pointerToRawData || 0) + (s.sizeOfRawData || 0);
    if (end > lastRawEnd) lastRawEnd = end;
  }
  const overlay = {
    present: buf.length > lastRawEnd && lastRawEnd > 0,
    offset: lastRawEnd,
    size: Math.max(0, buf.length - lastRawEnd),
  };
  const imports = parseImports(buf, sections, directories[1], pe32Plus);
  const exports = parseExports(buf, sections, directories[0]);
  return {
    format: pe32Plus ? "PE32+" : "PE32",
    pe32Plus,
    architecture: MACHINES[machine] || `unknown_0x${machine.toString(16)}`,
    machine,
    timeDateStamp,
    compileTimestamp: timeDateStamp
      ? new Date(timeDateStamp * 1000).toISOString()
      : null,
    characteristics,
    entryPoint: addressOfEntryPoint,
    imageBase: `0x${imageBase.toString(16)}`,
    numberOfSections,
    sections,
    directories,
    imports,
    exports,
    overlay,
    debugDirectory: directoryPresent(directories[6]),
    tlsCallbacks: directoryPresent(directories[9]),
    clr: directoryPresent(directories[14]),
    authenticode: directoryPresent(directories[4]),
    resources: directoryPresent(directories[2])
      ? { present: true, size: directories[2].size }
      : { present: false, size: 0 },
  };
}

export function detectPackerIndicators(pe) {
  const names = (pe.sections || []).map((s) => String(s.name || "").toLowerCase());
  const known = ["upx0", "upx1", "upx2", ".aspack", ".adata", "themida", ".mpress1", ".vmp0"];
  const hits = names.filter((n) => known.includes(n) || n.startsWith("upx"));
  return hits;
}

export { u16, u32, check };
