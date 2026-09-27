/**
 * Static binary inspection. Reads bytes only — never executes the file.
 */

import { createHash } from "node:crypto";
import { shannonEntropy, entropyAssessment, HIGH_ENTROPY_THRESHOLD } from "./entropy.mjs";
import { PeParseError, parsePe, detectPackerIndicators } from "./pe.mjs";
import { summarizeSignature, parseWinCertificateHint } from "./signatures.mjs";
import { securityResult } from "./evidence.mjs";

export const MAX_INSPECT_BYTES = 32 * 1024 * 1024;

export function hashesOf(buffer, { sha1 = false, md5 = false } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const out = {
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
  if (sha1) out.sha1 = createHash("sha1").update(buf).digest("hex");
  if (md5) out.md5 = createHash("md5").update(buf).digest("hex");
  return out;
}

export function detectMagic(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) return "MZ";
  if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "\x7fELF") return "ELF";
  if (buf.length >= 4 && buf[0] === 0xcf && buf[1] === 0xfa) return "Mach-O";
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) return "ZIP";
  if (buf.length >= 8 && buf.toString("latin1", 0, 8) === "!<arch>\n") return "AR";
  if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "%PDF") return "PDF";
  return "unknown";
}

export function inspectBinaryBuffer(
  buffer,
  {
    fileName = "file",
    sha1 = true,
    md5 = true,
  } = {},
) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length > MAX_INSPECT_BYTES) {
    return securityResult({
      tool: "security_binary_inspect",
      available: true,
      error: `File exceeds inspect bound (${MAX_INSPECT_BYTES} bytes)`,
      observed: { fileName, fileSize: buf.length },
    });
  }
  const digest = hashesOf(buf, { sha1, md5 });
  const magic = detectMagic(buf);
  const derived = {
    fileEntropy: shannonEntropy(buf.subarray(0, Math.min(buf.length, 2 * 1024 * 1024))),
  };
  const assessment = [];
  const unverified = [
    "Static inspection only. The file was not executed.",
  ];
  let pe = null;
  if (magic === "MZ") {
    try {
      pe = parsePe(buf);
    } catch (error) {
      if (error instanceof PeParseError) {
        return securityResult({
          tool: "security_binary_inspect",
          available: true,
          error: error.message,
          observed: {
            fileName,
            fileSize: buf.length,
            ...digest,
            magic,
            format: "MZ/unparsed",
          },
          derived,
          unverified: [
            ...unverified,
            "PE parse failed closed; no further PE fields are claimed.",
          ],
        });
      }
      throw error;
    }
  }
  const observed = {
    fileName,
    fileSize: buf.length,
    ...digest,
    magic,
    format: pe?.format || magic,
    architecture: pe?.architecture || null,
    compileTimestamp: pe?.compileTimestamp || null,
    entryPoint: pe?.entryPoint ?? null,
    imageBase: pe?.imageBase || null,
    sections: [],
    imports: [],
    exports: [],
    resources: pe?.resources || { present: false },
    debugDirectory: Boolean(pe?.debugDirectory),
    tlsCallbacks: Boolean(pe?.tlsCallbacks),
    clr: Boolean(pe?.clr),
    overlay: pe?.overlay || { present: false },
    executed: false,
  };
  if (pe) {
    observed.sections = pe.sections.map((s) => {
      const raw =
        s.pointerToRawData && s.sizeOfRawData
          ? buf.subarray(s.pointerToRawData, s.pointerToRawData + s.sizeOfRawData)
          : Buffer.alloc(0);
      const entropy = shannonEntropy(raw);
      const high = entropyAssessment(entropy);
      return {
        name: s.name,
        virtualSize: s.virtualSize,
        virtualAddress: s.virtualAddress,
        sizeOfRawData: s.sizeOfRawData,
        pointerToRawData: s.pointerToRawData,
        permissions: s.permissions,
        entropy,
        highEntropy: high.highEntropy,
      };
    });
    observed.imports = pe.imports.map((imp) => ({
      dll: imp.dll,
      apis: imp.apis.map((a) => a.name || `#${a.ordinal}`).slice(0, 80),
    }));
    observed.exports = (pe.exports?.names || []).map((e) => e.name).slice(0, 200);
    observed.exportDllName = pe.exports?.dllName || null;
    const sig = summarizeSignature(pe, {
      certificate: parseWinCertificateHint(buf, pe),
    });
    Object.assign(observed, sig.observed);
    unverified.push(...sig.unverified);
    const packerHits = detectPackerIndicators(pe);
    if (packerHits.length) {
      assessment.push(
        `packer-like section name(s) observed: ${packerHits.join(", ")}`,
      );
    }
    const highSections = observed.sections.filter((s) => s.highEntropy);
    if (highSections.length) {
      derived.highEntropySections = highSections.map((s) => s.name);
      assessment.push(
        `high entropy observed in section(s): ${highSections.map((s) => s.name).join(", ")} (threshold ${HIGH_ENTROPY_THRESHOLD})`,
      );
    }
    if (observed.overlay.present) {
      assessment.push(
        `overlay data present at offset ${observed.overlay.offset} (${observed.overlay.size} bytes)`,
      );
    }
    if (!observed.authenticodeDirectoryPresent) {
      assessment.push("unsigned executable (no Authenticode directory observed)");
    }
  }
  return securityResult({
    tool: "security_binary_inspect",
    observed,
    derived,
    assessment,
    unverified,
  });
}

export function compareBuffers(a, b, { labels = ["a", "b"] } = {}) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b);
  const ha = hashesOf(left);
  const hb = hashesOf(right);
  const equal = left.equals(right);
  return securityResult({
    tool: "security_hash",
    observed: {
      [labels[0]]: { size: left.length, sha256: ha.sha256 },
      [labels[1]]: { size: right.length, sha256: hb.sha256 },
      byteEqual: equal,
      sizeChanged: left.length !== right.length,
      hashChanged: ha.sha256 !== hb.sha256,
    },
    derived: {},
    assessment: [
      equal
        ? "byte-for-byte identical"
        : ha.sha256 === hb.sha256
          ? "SHA-256 matches"
          : "SHA-256 differs",
    ],
    unverified: [],
  });
}
