#!/usr/bin/env bash
# Per-boot startup: bring up the Ollama daemon and confirm it is ready.
# Must be idempotent and must return once the service is reachable.
set -euo pipefail

export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"

if curl -sf "http://$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
  echo "Ollama already running at $OLLAMA_HOST."
  exit 0
fi

nohup ollama serve >/tmp/ollama.log 2>&1 &

for _ in $(seq 1 30); do
  if curl -sf "http://$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
    echo "Ollama ready at $OLLAMA_HOST."
    exit 0
  fi
  sleep 1
done

echo "Ollama failed to become ready at $OLLAMA_HOST." >&2
cat /tmp/ollama.log >&2 || true
exit 1
