/**
 * Privileged conversation honorifics are bound to authenticated user IDs.
 * Chat text, display names, and "I'm Lubna" claims never grant Queen or Master.
 *
 * Queen binding (first match wins):
 *   1. process.env.COFFEEJACK_QUEEN_USER_ID
 *   2. store setting key "queenUserId" (settings table; not a users-row migration)
 *
 * If neither is set, no account receives Queen (fail-closed).
 * Owner role always receives Master, even if that user id were also bound as Queen.
 */

export const QUEEN_USER_ID_ENV = "COFFEEJACK_QUEEN_USER_ID";
export const QUEEN_USER_ID_SETTING = "queenUserId";

export function boundQueenUserId(store = null) {
  const fromEnv = String(process.env[QUEEN_USER_ID_ENV] || "").trim();
  if (fromEnv) return fromEnv;
  const stored = store?.get?.(QUEEN_USER_ID_SETTING, "");
  return String(stored || "").trim();
}

export function isQueenAccount(user, store = null) {
  const bound = boundQueenUserId(store);
  if (!bound || user?.id == null || user.id === "") return false;
  return String(user.id) === bound;
}

export function isMasterAccount(user) {
  return String(user?.role || "").toLowerCase() === "owner";
}

export function privilegedHonorific(user, store = null) {
  if (isMasterAccount(user)) return "Master";
  if (isQueenAccount(user, store)) return "Queen";
  return null;
}

export function accountBoundSpeaker(user, store = null) {
  if (isMasterAccount(user)) {
    const name =
      String(user?.display_name || user?.displayName || user?.name || "").trim() ||
      "Abdulrahman";
    return { speaker_name: name, honorific: "Master", gender: "m" };
  }
  if (isQueenAccount(user, store)) {
    return { speaker_name: "Lubna", honorific: "Queen", gender: "f" };
  }
  const display =
    String(user?.display_name || user?.displayName || user?.name || "").trim() ||
    "user";
  return {
    speaker_name: display,
    honorific: null,
    gender: null,
  };
}
