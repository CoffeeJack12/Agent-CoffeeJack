/**
 * Public verification/reset codes: 6 digits, HMAC at rest, never logged.
 * The install HMAC secret is generated once and stored in local settings
 * unless COFFEEJACK_AUTH_HMAC_SECRET is set.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const VERIFY_TTL_MS = 15 * 60 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
export const AUTH_HMAC_SETTING = "auth_hmac_secret";

export function generateSixDigitCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function isSixDigitCode(value) {
  return typeof value === "string" && /^\d{6}$/.test(value);
}

export function ensureAuthHmacSecret(store, env = process.env) {
  const fromEnv = env.COFFEEJACK_AUTH_HMAC_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const existing = store.get(AUTH_HMAC_SETTING);
  if (typeof existing === "string" && existing.length >= 32) return existing;
  const generated = randomBytes(32).toString("hex");
  store.set(AUTH_HMAC_SETTING, generated);
  return generated;
}

export function hashAuthCode(secret, { purpose, userId, code }) {
  return createHmac("sha256", secret)
    .update(`${purpose}\n${userId}\n${code}`, "utf8")
    .digest("hex");
}

export function hmacEquals(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
