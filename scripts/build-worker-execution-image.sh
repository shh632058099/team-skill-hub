#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=${1:-0.1.0}
IMAGE="team-skill-hub-expert-worker:${VERSION}"
OUT="$ROOT/artifacts/worker-runtime/expert-worker-image-${VERSION}.tar"
mkdir -p "$(dirname "$OUT")"
docker build --pull -t "$IMAGE" "$ROOT/docker/expert-worker"
docker save -o "$OUT" "$IMAGE"
printf 'Image: %s
Archive: %s
' "$IMAGE" "$OUT"
printf 'Transfer the archive to the Worker host and run: docker load -i %s
' "$(basename "$OUT")"
