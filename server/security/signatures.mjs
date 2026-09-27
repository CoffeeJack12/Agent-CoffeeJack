/**
 * Authenticode / certificate presence from PE directories.
 * Does not validate trust chains.
 */

export function summarizeSignature(pe, { certificate } = {}) {
  const present = Boolean(pe?.authenticode);
  const observed = {
    authenticodeDirectoryPresent: present,
    signed: present,
    certificateSubject: certificate?.subject || null,
    certificateIssuer: certificate?.issuer || null,
  };
  const unverified = [];
  if (present) {
    unverified.push(
      "Authenticode directory is present; signature validity and trust were not verified.",
    );
  } else {
    unverified.push("No Authenticode data directory was observed.");
  }
  return { observed, unverified };
}

export function parseWinCertificateHint(buffer, pe) {
  const dir = pe?.directories?.[4];
  if (!dir?.virtualAddress || !dir.size) return null;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  // IMAGE_DIRECTORY_ENTRY_SECURITY.VirtualAddress is a file offset, not an RVA.
  const off = dir.virtualAddress;
  if (off <= 0 || off + 8 > buf.length) return null;
  const length = buf.readUInt32LE(off);
  if (length < 8 || off + Math.min(length, 64) > buf.length) return null;
  return {
    attributeCertificateLength: length,
    revision: buf.readUInt16LE(off + 4),
    type: buf.readUInt16LE(off + 6),
  };
}
