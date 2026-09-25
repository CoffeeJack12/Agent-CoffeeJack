import sinkingCity2Adapter, { ALIASES, GAME_ID } from "./sinking-city-2.mjs";

const ADAPTERS = [sinkingCity2Adapter];

export function listAdapters() {
  return ADAPTERS;
}

export function resolveAdapter(game) {
  const key = String(game || "").trim().toLowerCase();
  if (!key) return sinkingCity2Adapter;
  return (
    ADAPTERS.find((adapter) => adapter.matches(key) || adapter.id === key) ||
    null
  );
}

export function defaultGameId() {
  return GAME_ID;
}

export { sinkingCity2Adapter, ALIASES, GAME_ID };
