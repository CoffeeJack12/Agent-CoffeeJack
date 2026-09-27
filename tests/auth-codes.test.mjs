import test from "node:test";
import assert from "node:assert/strict";
import {
  generateSixDigitCode,
  hashAuthCode,
  hmacEquals,
  isSixDigitCode,
  MAX_CODE_ATTEMPTS,
  RESET_TTL_MS,
  VERIFY_TTL_MS,
} from "../server/auth-codes.mjs";

test("auth codes are 6 digits and HMAC hashed, never equal to plaintext", () => {
  const code = generateSixDigitCode();
  assert.equal(isSixDigitCode(code), true);
  assert.match(code, /^\d{6}$/);
  const hash = hashAuthCode("install-secret-value", {
    purpose: "verify",
    userId: "user-1",
    code,
  });
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, code);
  assert.equal(
    hmacEquals(
      hash,
      hashAuthCode("install-secret-value", {
        purpose: "verify",
        userId: "user-1",
        code,
      }),
    ),
    true,
  );
  assert.equal(
    hmacEquals(
      hash,
      hashAuthCode("install-secret-value", {
        purpose: "verify",
        userId: "user-2",
        code,
      }),
    ),
    false,
  );
  assert.equal(MAX_CODE_ATTEMPTS, 5);
  assert.equal(VERIFY_TTL_MS, 15 * 60 * 1000);
  assert.equal(RESET_TTL_MS, 30 * 60 * 1000);
});
