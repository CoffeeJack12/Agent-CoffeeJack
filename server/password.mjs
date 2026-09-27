/**
 * Password hashing using Node's scrypt (modern KDF already in the stack).
 * Never log or return plaintext.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const PREFIX = "scrypt";

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

export function validatePasswordPolicy(password) {
  const value = String(password ?? "");
  if (value.length < PASSWORD_MIN)
    return { ok: false, error: `Password must be at least ${PASSWORD_MIN} characters` };
  if (value.length > PASSWORD_MAX)
    return { ok: false, error: "Password is too long" };
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value))
    return { ok: false, error: "Password must include letters and numbers" };
  if (/\s/.test(value))
    return { ok: false, error: "Password cannot contain spaces" };
  return { ok: true };
}

export async function hashPassword(password) {
  const policy = validatePasswordPolicy(password);
  if (!policy.ok) throw new Error(policy.error);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return [
    PREFIX,
    String(N),
    String(R),
    String(P),
    salt.toString("base64url"),
    Buffer.from(derived).toString("base64url"),
  ].join("$");
}

export function looksLikePasswordHash(value) {
  return typeof value === "string" && value.startsWith(`${PREFIX}$`);
}

export async function verifyPassword(password, encoded) {
  if (typeof encoded !== "string" || !encoded.startsWith(`${PREFIX}$`))
    return false;
  const parts = encoded.split("$");
  if (parts.length !== 6) return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (!salt.length || expected.length !== KEYLEN) return false;
  const derived = await scrypt(String(password ?? ""), salt, expected.length, {
    N: n,
    r,
    p,
  });
  const actual = Buffer.from(derived);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Dummy verify so missing accounts take a similar amount of work. */
export async function verifyPasswordDummy(password) {
  const salt = Buffer.alloc(16, 7);
  await scrypt(String(password ?? "x"), salt, KEYLEN, { N, r: R, p: P });
  return false;
}
