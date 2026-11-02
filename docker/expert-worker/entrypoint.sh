#!/bin/sh
set -eu

export CODEX_HOME="${CODEX_HOME:-/tmp/codex-home}"
mkdir -p "$CODEX_HOME"

# Import auth state and the explicitly selected per-worker Codex configuration.
# The host's default config.toml is never mounted implicitly.
if [ -f /run/codex-auth.json ]; then
  install -m 600 /run/codex-auth.json "$CODEX_HOME/auth.json"
fi

if [ -f /run/codex-config.toml ]; then
  install -m 600 /run/codex-config.toml "$CODEX_HOME/config.toml"
fi

exec codex "$@"
