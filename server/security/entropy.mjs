/**
 * Bounded Shannon entropy. Derived, not an observation of "packing".
 */

export function shannonEntropy(bytes) {
  if (!bytes || !bytes.length) return 0;
  const freq = new Array(256).fill(0);
  const len = bytes.length;
  for (let i = 0; i < len; i++) freq[bytes[i]]++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const c = freq[i];
    if (!c) continue;
    const p = c / len;
    h -= p * Math.log2(p);
  }
  return Math.round(h * 1000) / 1000;
}

/** Typical uncompressed code/data sits well below this. */
export const HIGH_ENTROPY_THRESHOLD = 7.2;

export function entropyAssessment(entropy, { threshold = HIGH_ENTROPY_THRESHOLD } = {}) {
  if (entropy >= threshold) {
    return {
      highEntropy: true,
      note: `high entropy observed (${entropy} bits/byte; threshold ${threshold})`,
    };
  }
  return { highEntropy: false, note: null };
}
