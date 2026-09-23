#!/usr/bin/env bash
# Long-running Ollama daemon, kept in the foreground as a visible terminal so
# it stays alive for the lifetime of the environment and its logs are inspectable.
set -euo pipefail

export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"

# If another instance is already serving, just tail alongside it instead of
# failing with "address already in use".
if curl -sf "http://$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
  echo "Ollama already running at $OLLAMA_HOST; nothing to start."
  exec sleep infinity
fi

exec ollama serve
