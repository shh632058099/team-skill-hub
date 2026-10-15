#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" ]] || { echo "node is required" >&2; exit 2; }
cd "$ROOT"
"$NODE_BIN" --import tsx --test \
  tests/client-integration-release.test.ts \
  tests/client-integration-build.test.ts \
  tests/client-integration-runtime.test.ts \
  tests/client-integration-session-start.test.ts \
  tests/client-integration-updater.test.ts \
  tests/client-integration-server.test.ts \
  tests/client-integration-bootstrap.test.ts \
  tests/client-integration-version-check.test.ts

if command -v codex >/dev/null 2>&1 && command -v claude >/dev/null 2>&1; then
  echo "Real Codex and Claude CLIs detected. Run the setup scripts against a disposable/local Hub and verify SessionStart notices before release."
elif [[ "${REQUIRE_REAL_CLIS:-0}" == "1" ]]; then
  echo "REQUIRE_REAL_CLIS=1 but codex and/or claude is unavailable" >&2
  exit 3
else
  echo "Fixture acceptance passed; real Codex/Claude SessionStart acceptance skipped because the CLIs are not installed."
fi
