import { sha256Buffer } from "./hashing.mjs";

export const TSC2_DYNAMIC_CLASS = "/Script/FrogwaresCore.DynamicSaveGameData";
export const TSC2_ECONOMY_CLASS = "/Script/Economy.EconomyManager";
export const TSC2_STACK_CLASS = "/Script/Economy.InventoryItemStack";

function fail(code, message, extra = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n));
  return b;
}

function i32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(Number(n));
  return b;
}

export function writeFString(value = "") {
  const text = String(value);
  const ascii = [...text].every((ch) => ch.charCodeAt(0) < 128);
  if (ascii) {
    const body = Buffer.from(text + "\0", "utf8");
    return Buffer.concat([i32(body.length), body]);
  }
  const body = Buffer.from(text + "\0", "utf16le");
  return Buffer.concat([i32(-(body.length / 2)), body]);
}
class Reader {
  constructor(buffer, offset = 0, limit = null) {
    this.buffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.p = offset;
    this.limit = limit == null ? this.buffer.length : limit;
  }

  take(n) {
    if (n < 0 || this.p + n > this.limit) throw fail("truncated_tsc2_save");
    const out = this.buffer.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }

  u32() {
    const b = this.take(4);
    return b.readUInt32LE(0);
  }

  string() {
    const n = this.take(4).readInt32LE(0);
    if (Math.abs(n) >= 100000) throw fail("invalid_fstring_length");
    if (n === 0) return "";
    const byteLength = Math.abs(n) * (n < 0 ? 2 : 1);
    const body = this.take(byteLength);
    if (n < 0) {
      if (body.length < 2 || body.readUInt16LE(body.length - 2) !== 0)
        throw fail("invalid_fstring_terminator");
      return body.subarray(0, -2).toString("utf16le");
    }
    if (body[body.length - 1] !== 0) throw fail("invalid_fstring_terminator");
    return body.subarray(0, -1).toString("utf8");
  }
  tree() {
    const name = this.string();
    const count = this.u32();
    if (count >= 10) throw fail("invalid_property_tree");
    const children = [];
    for (let i = 0; i < count; i++) children.push(this.tree());
    return { name, children };
  }

  props() {
    const props = [];
    while (this.p < this.limit) {
      const start = this.p;
      const name = this.string();
      if (name === "None") return props;
      const tree = this.tree();
      const sizeAt = this.p;
      const size = this.u32();
      const flag = this.take(1)[0];
      if (![0, 8, 16, 32].includes(flag)) throw fail("invalid_property_flag");
      const dataAt = this.p;
      const data = Buffer.from(this.take(size));
      props.push({
        name,
        tree,
        size,
        flag,
        start,
        sizeAt,
        dataAt,
        end: this.p,
        data,
      });
    }
    throw fail("property_list_unterminated");
  }
}

function sameTree(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameBuffer(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
}
function propertyBytes(parsed, prop) {
  return parsed.buffer.subarray(prop.start, prop.end);
}

function readPropertyString(parsed, prop) {
  const reader = new Reader(parsed.buffer, prop.dataAt, prop.end);
  const value = reader.string();
  if (reader.p !== prop.end) throw fail("unexpected_property_payload");
  return value;
}

function readPropertyInt(parsed, prop) {
  if (prop.size !== 4) throw fail("unexpected_int_property_size");
  return parsed.buffer.readUInt32LE(prop.dataAt);
}

function parseRawProps(parsed, part) {
  if (!part || part.name !== "RawData") throw fail("rawdata_property_missing");
  const reader = new Reader(parsed.buffer, part.dataAt, part.end);
  const payloadSize = reader.u32();
  if (payloadSize !== part.size - 4) throw fail("rawdata_size_mismatch");
  if (reader.take(1)[0] !== 0) throw fail("rawdata_prefix_mismatch");
  const props = reader.props();
  if (reader.p !== part.end - 4) throw fail("rawdata_trailing_size_mismatch");
  if (!reader.take(4).equals(Buffer.alloc(4))) throw fail("rawdata_trailer_mismatch");
  return props;
}

function parseStackList(parsed, stashProp) {
  const reader = new Reader(parsed.buffer, stashProp.dataAt, stashProp.end);
  const count = reader.u32();
  const records = [];
  for (let i = 0; i < count; i++) {
    const start = reader.p;
    const fields = reader.props();
    const end = reader.p;
    const classField = fields.find((p) => p.name === "Class");
    const rawField = fields.find((p) => p.name === "RawData");
    const className = classField ? readPropertyString(parsed, classField) : null;
    let item = null;
    let itemCount = null;
    let inner = [];
    if (rawField) {
      inner = parseRawProps(parsed, rawField);
      const itemField = inner.find((p) => p.name === "Item");
      const countField = inner.find((p) => p.name === "Count");
      if (itemField) item = readPropertyString(parsed, itemField);
      if (countField) itemCount = readPropertyInt(parsed, countField);
    }
    records.push({
      index: i,
      start,
      end,
      fields,
      className,
      inner,
      item,
      count: itemCount,
      raw: Buffer.from(parsed.buffer.subarray(start, end)),
    });
  }
  if (reader.p !== stashProp.end) throw fail("stash_payload_size_mismatch");
  return { count, records };
}

export function isTsc2DynamicSave(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false;
  if (buffer.subarray(0, 4).toString("ascii") !== "GVAS") return false;
  return buffer.indexOf(writeFString(TSC2_DYNAMIC_CLASS)) >= 0;
}

export function parseTsc2Save(input) {
  const buffer = Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(input);
  const marker = writeFString(TSC2_DYNAMIC_CLASS);
  const rootOffset = buffer.indexOf(marker);
  if (rootOffset < 0) throw fail("dynamic_save_root_missing");
  const parsed = { format: "tsc2-dynamic", buffer, sha256: sha256Buffer(buffer) };
  const reader = new Reader(buffer, rootOffset);
  const className = reader.string();
  if (className !== TSC2_DYNAMIC_CLASS) throw fail("dynamic_save_root_mismatch");
  if (reader.take(1)[0] !== 0) throw fail("dynamic_save_prefix_mismatch");
  const rootProps = reader.props();
  if (reader.p !== buffer.length - 4) throw fail("dynamic_save_root_size_mismatch");
  if (!reader.take(4).equals(Buffer.alloc(4))) throw fail("dynamic_save_trailer_mismatch");
  const saveData = rootProps.find((p) => p.name === "SaveData");
  if (!saveData) throw fail("save_data_missing");

  const mapReader = new Reader(buffer, saveData.dataAt, saveData.end);
  if (mapReader.u32() !== 0) throw fail("save_data_prefix_mismatch");
  const entryCount = mapReader.u32();
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const key = mapReader.string();
    const parts = mapReader.props();
    entries.push({ key, parts });
  }
  if (mapReader.p !== saveData.end) throw fail("save_data_size_mismatch");

  const economyEntry = entries.find((e) => e.key === TSC2_ECONOMY_CLASS);
  if (!economyEntry) throw fail("economy_manager_missing");
  const economyRaw = economyEntry.parts.find((p) => p.name === "RawData");
  const economyProps = parseRawProps(parsed, economyRaw);
  const stashProp = economyProps.find((p) => p.name === "StashedStacksSaveData");
  if (!stashProp) throw fail("stashed_stacks_missing");
  const stash = parseStackList(parsed, stashProp);

  parsed.root = { offset: rootOffset, className, props: rootProps, saveData, entries };
  parsed.economy = { entry: economyEntry, raw: economyRaw, props: economyProps };
  parsed.stash = { prop: stashProp, ...stash };
  return parsed;
}
function treeBytes(tree) {
  return Buffer.concat([
    writeFString(tree.name),
    u32(tree.children?.length || 0),
    ...(tree.children || []).map(treeBytes),
  ]);
}

function propertyBytesFromValue(name, tree, data, flag = 0) {
  return Buffer.concat([
    writeFString(name),
    treeBytes(tree),
    u32(data.length),
    Buffer.from([flag]),
    data,
  ]);
}

function stackBytes(asset) {
  const item = propertyBytesFromValue(
    "Item",
    { name: "ObjectProperty", children: [] },
    writeFString(asset),
  );
  const count = propertyBytesFromValue(
    "Count",
    { name: "IntProperty", children: [] },
    u32(1),
  );
  const raw = Buffer.concat([
    Buffer.from([0]),
    item,
    count,
    writeFString("None"),
    u32(0),
  ]);
  const klass = propertyBytesFromValue(
    "Class",
    { name: "ObjectProperty", children: [] },
    writeFString(TSC2_STACK_CLASS),
  );
  const rawData = propertyBytesFromValue(
    "RawData",
    {
      name: "ArrayProperty",
      children: [{ name: "ByteProperty", children: [] }],
    },
    Buffer.concat([u32(raw.length), raw]),
  );
  return Buffer.concat([klass, rawData, writeFString("None")]);
}

function replaceRange(buffer, start, end, replacement) {
  return Buffer.concat([
    buffer.subarray(0, start),
    replacement,
    buffer.subarray(end),
  ]);
}

function patchU32(buffer, offset, value) {
  const out = Buffer.from(buffer);
  out.writeUInt32LE(Number(value), offset);
  return out;
}

function validateStackShape(record) {
  if (record.className !== TSC2_STACK_CLASS) return false;
  if (record.fields.length !== 2) return false;
  if (record.fields[0].name !== "Class" || record.fields[1].name !== "RawData") return false;
  if (record.inner.length !== 2) return false;
  if (record.inner[0].name !== "Item" || record.inner[1].name !== "Count") return false;
  return record.count === 1 && typeof record.item === "string" && record.item.length > 0;
}

export function applyTsc2InfiniteAmmo(parsed, refs) {
  if (parsed?.format !== "tsc2-dynamic") throw fail("wrong_save_format");
  const existing = new Set(
    parsed.stash.records.filter(validateStackShape).map((r) => r.item),
  );
  const added = refs.filter((ref) => !existing.has(ref));
  const alreadyPresent = refs.filter((ref) => existing.has(ref));
  if (!added.length) return { added, alreadyPresent, total: parsed.stash.count };
  const appended = Buffer.concat(added.map(stackBytes));
  const oldStash = parsed.stash.prop;
  const oldStashData = parsed.buffer.subarray(oldStash.dataAt, oldStash.end);
  const newStashData = Buffer.concat([
    u32(parsed.stash.count + added.length),
    oldStashData.subarray(4),
    appended,
  ]);
  const newStashProp = Buffer.concat([
    parsed.buffer.subarray(oldStash.start, oldStash.sizeAt),
    u32(newStashData.length),
    parsed.buffer.subarray(oldStash.sizeAt + 4, oldStash.dataAt),
    newStashData,
  ]);
  const delta = newStashProp.length - (oldStash.end - oldStash.start);
  let out = replaceRange(parsed.buffer, oldStash.start, oldStash.end, newStashProp);

  const economyRaw = parsed.economy.raw;
  out = patchU32(out, economyRaw.sizeAt, economyRaw.size + delta);
  const oldInnerSize = parsed.buffer.readUInt32LE(economyRaw.dataAt);
  out = patchU32(out, economyRaw.dataAt, oldInnerSize + delta);

  const saveData = parsed.root.saveData;
  out = patchU32(out, saveData.sizeAt, saveData.size + delta);

  const reparsed = parseTsc2Save(out);
  Object.keys(parsed).forEach((key) => delete parsed[key]);
  Object.assign(parsed, reparsed);
  return {
    added,
    alreadyPresent,
    total: parsed.stash.count,
    bytesAdded: delta,
  };
}

function samePropertySignature(a, b) {
  return a?.name === b?.name && a?.flag === b?.flag && sameTree(a?.tree, b?.tree);
}
function comparePropertyLists(before, after, beforeParsed, afterParsed, exceptName = null) {
  if (before.length !== after.length) return { ok: false, reason: "property_count_changed" };
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after[i];
    if (!samePropertySignature(a, b)) return { ok: false, reason: "property_schema_changed" };
    if (a.name === exceptName) continue;
    if (!sameBuffer(propertyBytes(beforeParsed, a), propertyBytes(afterParsed, b)))
      return { ok: false, reason: "unrelated_property_changed", property: a.name };
  }
  return { ok: true };
}

export function compareTsc2Preservation(beforeInput, afterInput) {
  const before = beforeInput?.format === "tsc2-dynamic" ? beforeInput : parseTsc2Save(beforeInput);
  const after = afterInput?.format === "tsc2-dynamic" ? afterInput : parseTsc2Save(afterInput);
  const failResult = (reason, extra = {}) => ({ ok: false, reason, addedRefs: [], ...extra });

  if (before.root.entries.length !== after.root.entries.length)
    return failResult("save_entry_count_changed");
  for (let i = 0; i < before.root.entries.length; i++) {
    const a = before.root.entries[i];
    const b = after.root.entries[i];
    if (a.key !== b.key) return failResult("save_entry_key_changed");
    const check = comparePropertyLists(
      a.parts,
      b.parts,
      before,
      after,
      a.key === TSC2_ECONOMY_CLASS ? "RawData" : null,
    );
    if (!check.ok) return failResult(check.reason, check);
  }

  const economyCheck = comparePropertyLists(
    before.economy.props,
    after.economy.props,
    before,
    after,
    "StashedStacksSaveData",
  );
  if (!economyCheck.ok) return failResult(economyCheck.reason, economyCheck);
  if (after.stash.count < before.stash.count) return failResult("stash_count_decreased");
  for (let i = 0; i < before.stash.count; i++) {
    if (!sameBuffer(before.stash.records[i].raw, after.stash.records[i].raw))
      return failResult("existing_stash_record_changed", { index: i });
  }

  const addedRecords = after.stash.records.slice(before.stash.count);
  const addedRefs = [];
  for (const record of addedRecords) {
    if (!validateStackShape(record)) return failResult("added_stack_shape_invalid");
    addedRefs.push(record.item);
  }

  const beforePrefix = before.buffer.subarray(0, before.root.saveData.sizeAt);
  const afterPrefix = after.buffer.subarray(0, after.root.saveData.sizeAt);
  if (!sameBuffer(beforePrefix, afterPrefix)) return failResult("save_prefix_changed");
  const beforeSuffix = before.buffer.subarray(before.root.saveData.end);
  const afterSuffix = after.buffer.subarray(after.root.saveData.end);
  if (!sameBuffer(beforeSuffix, afterSuffix)) return failResult("save_suffix_changed");

  return {
    ok: true,
    addedRefs,
    oldStashCount: before.stash.count,
    newStashCount: after.stash.count,
    bytesAdded: after.buffer.length - before.buffer.length,
  };
}

export function learnTsc2InfiniteAmmoReference(beforeInput, afterInput) {
  const before = beforeInput?.format === "tsc2-dynamic" ? beforeInput : parseTsc2Save(beforeInput);
  const after = afterInput?.format === "tsc2-dynamic" ? afterInput : parseTsc2Save(afterInput);
  const preservation = compareTsc2Preservation(before, after);
  if (!preservation.ok) throw fail("reference_edit_not_isolated", preservation.reason, preservation);
  if (preservation.addedRefs.length !== 5)
    throw fail("reference_edit_expected_five_items", "Expected exactly five added ammo items", {
      count: preservation.addedRefs.length,
    });
  if (new Set(preservation.addedRefs).size !== 5)
    throw fail("reference_edit_duplicate_items");
  return {
    ok: true,
    originalSha256: before.sha256,
    modifiedSha256: after.sha256,
    ...preservation,
    refs: [...preservation.addedRefs],
  };
}

export function serializeTsc2Save(parsed) {
  if (parsed?.format !== "tsc2-dynamic") throw fail("wrong_save_format");
  return Buffer.from(parsed.buffer);
}
