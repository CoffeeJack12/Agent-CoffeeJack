import { sha256Buffer } from "./hashing.mjs";

export const GVAS_MAGIC = Buffer.from("GVAS", "ascii");

class Cursor {
  constructor(buffer) {
    this.buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.o = 0;
  }
  get remaining() {
    return this.buf.length - this.o;
  }
  require(n) {
    if (this.o + n > this.buf.length) {
      const err = new Error("truncated_gvas");
      err.code = "truncated_gvas";
      throw err;
    }
  }
  u8() {
    this.require(1);
    return this.buf[this.o++];
  }
  i32() {
    this.require(4);
    const v = this.buf.readInt32LE(this.o);
    this.o += 4;
    return v;
  }
  u32() {
    this.require(4);
    const v = this.buf.readUInt32LE(this.o);
    this.o += 4;
    return v;
  }
  i64() {
    this.require(8);
    const v = this.buf.readBigInt64LE(this.o);
    this.o += 8;
    return v;
  }
  u16() {
    this.require(2);
    const v = this.buf.readUInt16LE(this.o);
    this.o += 2;
    return v;
  }
  f32() {
    this.require(4);
    const v = this.buf.readFloatLE(this.o);
    this.o += 4;
    return v;
  }
  f64() {
    this.require(8);
    const v = this.buf.readDoubleLE(this.o);
    this.o += 8;
    return v;
  }
  bytes(n) {
    this.require(n);
    const slice = this.buf.subarray(this.o, this.o + n);
    this.o += n;
    return Buffer.from(slice);
  }
  sliceFrom(start) {
    return this.buf.subarray(start, this.o);
  }
  fstring() {
    const len = this.i32();
    if (len === 0) return "";
    if (len < 0) {
      const bytes = -len * 2;
      this.require(bytes);
      const text = this.buf.toString("utf16le", this.o, this.o + bytes - 2);
      this.o += bytes;
      return text.replace(/\0+$/, "");
    }
    this.require(len);
    const text = this.buf.toString("latin1", this.o, this.o + len - 1);
    this.o += len;
    return text.replace(/\0+$/, "");
  }
}

function writeI32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
}
function writeU32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function writeU16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function writeI64(n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(typeof n === "bigint" ? n : BigInt(n));
  return b;
}
function writeF32(n) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(n);
  return b;
}
function writeF64(n) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n);
  return b;
}

export function writeFString(value = "") {
  const text = String(value);
  if (text === "") return writeI32(0);
  const ascii = [...text].every((ch) => ch.charCodeAt(0) < 128);
  if (ascii) {
    const body = Buffer.from(`${text}\0`, "latin1");
    return Buffer.concat([writeI32(body.length), body]);
  }
  const body = Buffer.from(`${text}\0`, "utf16le");
  return Buffer.concat([writeI32(-(body.length / 2)), body]);
}

function concat(parts) {
  return Buffer.concat(parts.filter(Boolean));
}

function noneTag() {
  return writeFString("None");
}

export function isGvas(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 4 &&
    buffer.subarray(0, 4).equals(GVAS_MAGIC)
  );
}

function readHeader(cur) {
  const start = cur.o;
  const magic = cur.bytes(4);
  if (!magic.equals(GVAS_MAGIC)) {
    const err = new Error("not_gvas");
    err.code = "not_gvas";
    throw err;
  }
  const saveGameFileVersion = cur.u32();
  let packageUe4 = null;
  let packageUe5 = null;
  let packageVersion = null;
  if (saveGameFileVersion >= 3) {
    packageUe4 = cur.i32();
    packageUe5 = cur.i32();
  } else {
    packageVersion = cur.i32();
  }
  const engine = {
    major: cur.u16(),
    minor: cur.u16(),
    patch: cur.u16(),
    changelist: cur.u32(),
    branch: cur.fstring(),
  };
  const customVersionFormat = cur.i32();
  const customCount = cur.i32();
  const customVersions = [];
  for (let i = 0; i < customCount; i++) {
    customVersions.push({ guid: cur.bytes(16), version: cur.i32() });
  }
  const saveGameClassName = cur.fstring();
  return {
    header: {
      saveGameFileVersion,
      packageUe4,
      packageUe5,
      packageVersion,
      engine,
      customVersionFormat,
      customVersions,
      saveGameClassName,
    },
    headerRaw: Buffer.from(cur.buf.subarray(start, cur.o)),
  };
}

function writeHeader(header) {
  const parts = [Buffer.from(GVAS_MAGIC)];
  parts.push(writeU32(header.saveGameFileVersion ?? 3));
  if ((header.saveGameFileVersion ?? 3) >= 3) {
    parts.push(writeI32(header.packageUe4 ?? 522));
    parts.push(writeI32(header.packageUe5 ?? 1008));
  } else {
    parts.push(writeI32(header.packageVersion ?? 522));
  }
  const engine = header.engine || {};
  parts.push(writeU16(engine.major ?? 5));
  parts.push(writeU16(engine.minor ?? 4));
  parts.push(writeU16(engine.patch ?? 4));
  parts.push(writeU32(engine.changelist ?? 0));
  parts.push(writeFString(engine.branch ?? ""));
  parts.push(writeI32(header.customVersionFormat ?? 3));
  const customs = header.customVersions || [];
  parts.push(writeI32(customs.length));
  for (const custom of customs) {
    parts.push(Buffer.from(custom.guid));
    parts.push(writeI32(custom.version));
  }
  parts.push(writeFString(header.saveGameClassName || "/Script/Engine.SaveGame"));
  return concat(parts);
}

function readProperty(cur) {
  const start = cur.o;
  const name = cur.fstring();
  if (name === "None") {
    return {
      name: "None",
      type: "None",
      terminator: true,
      raw: Buffer.from(cur.sliceFrom(start)),
      dirty: false,
    };
  }
  const type = cur.fstring();
  const size = cur.i32();
  const index = cur.i32();
  const node = {
    name,
    type,
    size,
    index,
    dirty: false,
    extra: {},
    children: null,
    value: undefined,
  };

  if (type === "BoolProperty") {
    node.value = cur.u8() !== 0;
    node.hasGuid = cur.u8();
    if (node.hasGuid) node.guid = cur.bytes(16);
  } else if (type === "StructProperty") {
    node.extra.structType = cur.fstring();
    node.extra.structGuid = cur.bytes(16);
    node.hasGuid = cur.u8();
    if (node.hasGuid) node.guid = cur.bytes(16);
    const payloadStart = cur.o;
    node.children = readPropertyList(cur, payloadStart + size);
    if (cur.o !== payloadStart + size) {
      node.payloadRaw = Buffer.from(cur.buf.subarray(payloadStart, payloadStart + size));
      cur.o = payloadStart + size;
      node.children = null;
      node.valueKind = "opaque-struct";
    }
  } else if (type === "ArrayProperty") {
    node.extra.innerType = cur.fstring();
    node.hasGuid = cur.u8();
    if (node.hasGuid) node.guid = cur.bytes(16);
    const payloadStart = cur.o;
    node.payloadRaw = Buffer.from(cur.buf.subarray(payloadStart, payloadStart + size));
    cur.o = payloadStart;
    node.children = readArrayPayload(cur, node.extra.innerType, size);
    if (cur.o !== payloadStart + size) {
      cur.o = payloadStart + size;
      node.valueKind = "opaque-array";
    }
  } else {
    node.hasGuid = cur.u8();
    if (node.hasGuid) node.guid = cur.bytes(16);
    if (type === "EnumProperty" || type === "ByteProperty") {
      node.extra.enumType = cur.buf.subarray(0, 0);
    }
    const payloadStart = cur.o;
    if (
      (type === "ByteProperty" || type === "EnumProperty") &&
      size >= 4
    ) {
      // Extra enum name lives in the type-specific header for these types.
      // Rewind: those names were consumed as hasGuid incorrectly on some files.
    }
    node.value = readScalar(cur, type, size, node);
    if (cur.o !== payloadStart + size && type !== "BoolProperty") {
      cur.o = payloadStart;
      node.value = cur.bytes(size);
      node.valueKind = "opaque";
    }
  }
  node.raw = Buffer.from(cur.sliceFrom(start));
  return node;
}

function readScalar(cur, type, size) {
  switch (type) {
    case "Int8Property":
      return cur.u8();
    case "Int16Property":
      return cur.u16();
    case "UInt16Property":
      return cur.u16();
    case "IntProperty":
    case "Int32Property":
      return cur.i32();
    case "UInt32Property":
      return cur.u32();
    case "Int64Property":
      return cur.i64();
    case "UInt64Property":
      return cur.i64();
    case "FloatProperty":
      return cur.f32();
    case "DoubleProperty":
      return cur.f64();
    case "StrProperty":
    case "NameProperty":
    case "SoftObjectProperty":
    case "SoftClassProperty":
    case "ObjectProperty": {
      const first = cur.fstring();
      if (size > 0) {
        // Soft paths sometimes include a second (sub-path) string.
        const consumedGuess = Buffer.byteLength(first) + 5;
        if (cur.remaining >= 4 && consumedGuess < size) {
          const peek = cur.buf.readInt32LE(cur.o);
          if (peek === 0 || Math.abs(peek) < 1024) {
            const second = cur.fstring();
            return second ? `${first}:${second}` : first;
          }
        }
      }
      return first;
    }
    case "EnumProperty":
    case "ByteProperty":
      if (size === 1) return cur.u8();
      return cur.fstring();
    case "TextProperty":
      return cur.bytes(size);
    default:
      return cur.bytes(size);
  }
}

function readPropertyList(cur, end = Infinity) {
  const list = [];
  while (cur.o < end && cur.remaining > 0) {
    const node = readProperty(cur);
    list.push(node);
    if (node.terminator) break;
  }
  return list;
}

function readArrayPayload(cur, innerType, size) {
  const end = cur.o + size;
  if (innerType === "StructProperty") {
    const count = cur.i32();
    const elements = [];
    if (cur.o < end && cur.remaining > 4) {
      const peekNameStart = cur.o;
      try {
        const name = cur.fstring();
        const type = cur.fstring();
        if (type === "StructProperty") {
          const structSize = cur.i32();
          const index = cur.i32();
          const structType = cur.fstring();
          const structGuid = cur.bytes(16);
          const hasGuid = cur.u8();
          const guid = hasGuid ? cur.bytes(16) : null;
          for (let i = 0; i < count; i++) {
            elements.push({
              type: "StructProperty",
              extra: { structType },
              children: readPropertyList(cur),
              dirty: false,
            });
          }
          return {
            format: "ue4-struct-array",
            count,
            dummy: { name, type, structSize, index, structType, structGuid, hasGuid, guid },
            elements,
          };
        }
      } catch {
        cur.o = peekNameStart;
      }
      cur.o = peekNameStart;
    }
    for (let i = 0; i < count && cur.o < end; i++) {
      elements.push({
        type: "StructProperty",
        extra: { structType: innerType },
        children: readPropertyList(cur),
        dirty: false,
      });
    }
    return { format: "bare-struct-array", count, elements };
  }
  const count = cur.i32();
  const elements = [];
  for (let i = 0; i < count && cur.o < end; i++) {
    if (innerType === "BoolProperty") elements.push({ value: cur.u8() !== 0 });
    else if (innerType === "IntProperty") elements.push({ value: cur.i32() });
    else if (innerType === "StrProperty" || innerType === "NameProperty")
      elements.push({ value: cur.fstring() });
    else if (innerType === "FloatProperty") elements.push({ value: cur.f32() });
    else elements.push({ value: cur.bytes(Math.min(4, end - cur.o)), opaque: true });
  }
  return { format: "scalar-array", count, elements };
}

function writePropertyList(list) {
  const parts = [];
  for (const node of list || []) {
    if (node.terminator) {
      parts.push(noneTag());
      continue;
    }
    parts.push(writeProperty(node));
  }
  if (!list?.some((n) => n.terminator)) parts.push(noneTag());
  return concat(parts);
}

function writeGuidFlag(node) {
  const parts = [Buffer.from([node.hasGuid ? 1 : 0])];
  if (node.hasGuid && node.guid) parts.push(Buffer.from(node.guid));
  return concat(parts);
}

function writeScalar(node) {
  const type = node.type;
  const value = node.value;
  if (node.valueKind === "opaque" && Buffer.isBuffer(value)) return value;
  switch (type) {
    case "Int8Property":
      return Buffer.from([Number(value) & 0xff]);
    case "Int16Property":
    case "UInt16Property":
      return writeU16(Number(value));
    case "IntProperty":
    case "Int32Property":
      return writeI32(Number(value));
    case "UInt32Property":
      return writeU32(Number(value));
    case "Int64Property":
    case "UInt64Property":
      return writeI64(value ?? 0);
    case "FloatProperty":
      return writeF32(Number(value));
    case "DoubleProperty":
      return writeF64(Number(value));
    case "StrProperty":
    case "NameProperty":
    case "ObjectProperty":
    case "SoftObjectProperty":
    case "SoftClassProperty": {
      const text = String(value ?? "");
      const [main, sub] = text.includes(":") && type.startsWith("Soft")
        ? text.split(/:(.*)/s)
        : [text, ""];
      if (type.startsWith("Soft"))
        return concat([writeFString(main), writeFString(sub || "")]);
      return writeFString(main);
    }
    case "EnumProperty":
    case "ByteProperty":
      return typeof value === "number"
        ? Buffer.from([value])
        : writeFString(String(value ?? ""));
    case "TextProperty":
      return Buffer.isBuffer(value) ? value : writeFString(String(value ?? ""));
    default:
      return Buffer.isBuffer(value) ? value : Buffer.alloc(0);
  }
}

function writeArrayPayload(node) {
  if (node.valueKind === "opaque-array" && node.payloadRaw)
    return Buffer.from(node.payloadRaw);
  const payload = node.children || { format: "scalar-array", count: 0, elements: [] };
  const inner = node.extra?.innerType;
  if (inner === "StructProperty") {
    const elements = payload.elements || [];
    const dummy = payload.dummy || {
      name: node.name,
      type: "StructProperty",
      index: 0,
      structType:
        payload.elements?.[0]?.extra?.structType || "Struct",
      structGuid: Buffer.alloc(16),
      hasGuid: 0,
    };
    const bodies = elements.map((el) => writePropertyList(el.children || []));
    if (payload.format === "bare-struct-array") {
      return concat([writeI32(elements.length), ...bodies]);
    }
    const dummyBody = concat(bodies);
    const dummyTag = concat([
      writeFString(dummy.name || node.name),
      writeFString("StructProperty"),
      writeI32(dummyBody.length),
      writeI32(dummy.index || 0),
      writeFString(dummy.structType),
      Buffer.from(dummy.structGuid || Buffer.alloc(16)),
      Buffer.from([dummy.hasGuid ? 1 : 0]),
      dummy.hasGuid && dummy.guid ? Buffer.from(dummy.guid) : null,
    ]);
    return concat([writeI32(elements.length), dummyTag, dummyBody]);
  }
  const elements = payload.elements || [];
  const parts = [writeI32(elements.length)];
  for (const el of elements) {
    if (inner === "BoolProperty") parts.push(Buffer.from([el.value ? 1 : 0]));
    else if (inner === "IntProperty") parts.push(writeI32(Number(el.value)));
    else if (inner === "StrProperty" || inner === "NameProperty")
      parts.push(writeFString(String(el.value ?? "")));
    else if (inner === "FloatProperty") parts.push(writeF32(Number(el.value)));
    else if (Buffer.isBuffer(el.value)) parts.push(el.value);
  }
  return concat(parts);
}

export function writeProperty(node) {
  if (!node || node.terminator) return noneTag();
  if (!node.dirty && node.raw) return Buffer.from(node.raw);
  if (node.type === "BoolProperty") {
    return concat([
      writeFString(node.name),
      writeFString("BoolProperty"),
      writeI32(0),
      writeI32(node.index || 0),
      Buffer.from([node.value ? 1 : 0]),
      writeGuidFlag(node),
    ]);
  }
  if (node.type === "StructProperty") {
    const body =
      node.children
        ? writePropertyList(node.children)
        : Buffer.from(node.payloadRaw || []);
    return concat([
      writeFString(node.name),
      writeFString("StructProperty"),
      writeI32(body.length),
      writeI32(node.index || 0),
      writeFString(node.extra?.structType || "Struct"),
      Buffer.from(node.extra?.structGuid || Buffer.alloc(16)),
      writeGuidFlag(node),
      body,
    ]);
  }
  if (node.type === "ArrayProperty") {
    const body = writeArrayPayload(node);
    return concat([
      writeFString(node.name),
      writeFString("ArrayProperty"),
      writeI32(body.length),
      writeI32(node.index || 0),
      writeFString(node.extra?.innerType || "StructProperty"),
      writeGuidFlag(node),
      body,
    ]);
  }
  const body = writeScalar(node);
  return concat([
    writeFString(node.name),
    writeFString(node.type),
    writeI32(body.length),
    writeI32(node.index || 0),
    writeGuidFlag(node),
    body,
  ]);
}

export function parseGvas(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (!isGvas(buffer)) {
    const err = new Error("not_gvas");
    err.code = "not_gvas";
    throw err;
  }
  const cur = new Cursor(buffer);
  const { header, headerRaw } = readHeader(cur);
  const propertiesStart = cur.o;
  const properties = readPropertyList(cur);
  const trailerRaw = Buffer.from(cur.buf.subarray(cur.o));
  return {
    header,
    headerRaw,
    properties,
    trailerRaw,
    propertiesStart,
    byteLength: buffer.length,
    sha256: sha256Buffer(buffer),
  };
}

export function serializeGvas(save) {
  const header = save.headerRaw || writeHeader(save.header);
  const body = writePropertyList(save.properties);
  const trailer = save.trailerRaw || Buffer.alloc(0);
  return Buffer.concat([header, body, trailer]);
}

export function defaultHeader(className = "/Script/Engine.SaveGame") {
  return {
    saveGameFileVersion: 3,
    packageUe4: 522,
    packageUe5: 1008,
    engine: { major: 5, minor: 4, patch: 4, changelist: 0, branch: "" },
    customVersionFormat: 3,
    customVersions: [],
    saveGameClassName: className,
  };
}

export function makeNone() {
  return { name: "None", type: "None", terminator: true, dirty: true };
}

export function makeInt(name, value) {
  return { name, type: "IntProperty", value, index: 0, dirty: true };
}

export function makeStr(name, value) {
  return { name, type: "StrProperty", value, index: 0, dirty: true };
}

export function makeSoftClass(name, value) {
  return { name, type: "SoftClassProperty", value, index: 0, dirty: true };
}

export function makeStruct(name, structType, children) {
  return {
    name,
    type: "StructProperty",
    extra: { structType, structGuid: Buffer.alloc(16) },
    children: [...children, makeNone()],
    index: 0,
    dirty: true,
  };
}

export function makeStructArray(name, structType, elements) {
  return {
    name,
    type: "ArrayProperty",
    extra: { innerType: "StructProperty" },
    children: {
      format: "ue4-struct-array",
      dummy: {
        name,
        structType,
        structGuid: Buffer.alloc(16),
        hasGuid: 0,
        index: 0,
      },
      elements: elements.map((el) => ({
        type: "StructProperty",
        extra: { structType },
        children: el.children || el,
        dirty: true,
      })),
    },
    index: 0,
    dirty: true,
  };
}

export function findProperty(list, name) {
  return (list || []).find((node) => node.name === name && !node.terminator) || null;
}

export function walkPath(save, pathNames) {
  let current = save.properties;
  let node = null;
  for (const name of pathNames) {
    node = findProperty(current, name);
    if (!node) return null;
    current = node.children;
  }
  return node;
}

export function cloneSave(save) {
  return parseGvas(serializeGvas(save));
}

function scalarSummary(node) {
  if (!node) return null;
  if (node.type === "ArrayProperty") {
    return {
      type: node.type,
      innerType: node.extra?.innerType,
      count: node.children?.elements?.length ?? node.children?.count ?? 0,
    };
  }
  if (node.type === "StructProperty") {
    const children = {};
    for (const child of node.children || []) {
      if (child.terminator) continue;
      children[child.name] = scalarSummary(child);
    }
    return { type: node.type, structType: node.extra?.structType, children };
  }
  if (Buffer.isBuffer(node.value)) return { type: node.type, bytes: node.value.length };
  return { type: node.type, value: node.value };
}

export function semanticSnapshot(save, extraPaths = []) {
  const snap = {
    className: save.header?.saveGameClassName || null,
    properties: {},
  };
  for (const node of save.properties || []) {
    if (node.terminator) continue;
    snap.properties[node.name] = scalarSummary(node);
  }
  for (const pathNames of extraPaths) {
    const node = walkPath(save, pathNames);
    snap[pathNames.join(".")] = node ? scalarSummary(node) : null;
  }
  return snap;
}

export function diffSnapshots(before, after) {
  const changes = [];
  const walk = (a, b, prefix) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (
      a &&
      b &&
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) walk(a[key], b[key], prefix ? `${prefix}.${key}` : key);
      return;
    }
    changes.push({ path: prefix, before: a, after: b });
  };
  walk(before, after, "");
  return changes;
}

export function buildFixtureSave({
  className = "/Script/CoffeeJack.FixtureSaveGame",
  storyFlag = "chapter-3",
  playTime = 12345,
  volume = 80,
  currency = 999,
  stacks = [],
  includeEconomy = true,
  includeStacks = true,
  stackStructType = "/Script/Economy.InventoryItemStack",
} = {}) {
  const progress = makeStruct("Progress", "ProgressState", [
    makeStr("StoryFlag", storyFlag),
    makeInt("PlayTime", playTime),
  ]);
  const settings = makeStruct("Settings", "GameSettings", [makeInt("Volume", volume)]);
  const properties = [progress, settings];
  if (includeEconomy) {
    const economyChildren = [makeInt("Currency", currency)];
    if (includeStacks) {
      economyChildren.push(
        makeStructArray(
          "StashedStacksSaveData",
          stackStructType,
          stacks.map((stack) => ({
            children: [
              makeSoftClass("Item", stack.item),
              makeInt("Count", stack.count ?? 1),
              makeNone(),
            ],
          })),
        ),
      );
    }
    properties.push(makeStruct("EconomyManager", "EconomyManager", economyChildren));
  }
  properties.push(makeNone());
  const save = {
    header: defaultHeader(className),
    properties,
    trailerRaw: Buffer.alloc(0),
  };
  return parseGvas(serializeGvas(save));
}
