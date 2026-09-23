#!/usr/bin/env bash
# Long-running CoffeeJack server. Presented as a visible terminal so its
# logs and lifecycle stay observable to the agent.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use 24 >/dev/null
export PATH="$(dirname "$(nvm which 24)"):$PATH"

export COFFEEJACK_PORT="${COFFEEJACK_PORT:-3210}"
export OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
export COFFEEJACK_MODEL="${COFFEEJACK_MODEL:-qwen3:0.6b}"

# Give Ollama a moment so the first status/chat request already sees the model.
for _ in $(seq 1 30); do
  curl -sf "$OLLAMA_URL/api/tags" >/dev/null 2>&1 && break
  sleep 1
done

exec node server/index.mjs
