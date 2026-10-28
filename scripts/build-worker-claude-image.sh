#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=${1:-0.1.0}
IMAGE="team-skill-hub-expert-claude:${VERSION}"
OUT="$ROOT/artifacts/worker-runtime/expert-claude-image-${VERSION}.tar"
mkdir -p "$(dirname "$OUT")"
docker build --pull -f "$ROOT/docker/expert-worker/Dockerfile.claude" -t "$IMAGE" "$ROOT/docker/expert-worker"
docker save -o "$OUT" "$IMAGE"
printf 'Image: %s\nArchive: %s\n' "$IMAGE" "$OUT"
