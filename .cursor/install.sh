#!/usr/bin/env bash
# One-time, idempotent setup for the CoffeeJack Cloud Agent environment.
# Runs after the repository is checked out. Safe to run repeatedly.
set -euo pipefail

# Keep pnpm and other tools non-interactive (no TTY during environment setup).
export CI=true

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# --- Node 24 (required for node:sqlite and the >=24 engine constraint) ---
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  mkdir -p "$NVM_DIR"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 24 >/dev/null
nvm alias default 24 >/dev/null
nvm use 24 >/dev/null
export PATH="$(dirname "$(nvm which 24)"):$PATH"
corepack enable
corepack prepare pnpm@10.33.3 --activate

# --- System packages: zstd is required by the Ollama installer ---
sudo apt-get update -qq
sudo apt-get install -y -qq zstd

# --- Project dependencies (pinned by pnpm-lock.yaml) ---
pnpm install --frozen-lockfile

# --- Playwright Chromium: powers the browser tool and the UI smoke test ---
pnpm exec playwright install --with-deps chromium

# --- Ollama: local model runtime used by the assistant ---
if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sudo sh
fi

# --- Pull a small, fast chat model so the assistant works out of the box.
# The RTX-class 8B models from the README need a GPU; qwen3:0.6b runs on CPU. ---
export OLLAMA_HOST="127.0.0.1:11434"
if ! curl -sf "http://$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
  ollama serve >/tmp/ollama-install.log 2>&1 &
  serve_pid=$!
  for _ in $(seq 1 30); do
    curl -sf "http://$OLLAMA_HOST/api/tags" >/dev/null 2>&1 && break
    sleep 1
  done
else
  serve_pid=""
fi
ollama pull qwen3:0.6b
if [ -n "$serve_pid" ]; then
  kill "$serve_pid" >/dev/null 2>&1 || true
  wait "$serve_pid" 2>/dev/null || true
fi

echo "CoffeeJack environment install complete."
