#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BACKEND=${1:-claude}
VERSION=${2:-0.1.0}

case "$BACKEND" in
  claude)
    IMAGE="team-skill-hub-expert-claude:${VERSION}"
    DOCKERFILE="$ROOT/docker/expert-worker/Dockerfile.claude"
    ARCHIVE="expert-claude-image-${VERSION}.tar"
    ;;
  codex)
    IMAGE="team-skill-hub-expert-worker:${VERSION}"
    DOCKERFILE="$ROOT/docker/expert-worker/Dockerfile"
    ARCHIVE="expert-worker-image-${VERSION}.tar"
    ;;
  *)
    printf 'Usage: %s [claude|codex] [version]\n' "${0##*/}" >&2
    exit 2
    ;;
esac

if [[ ! "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  printf 'Invalid image version: %s\n' "$VERSION" >&2
  exit 2
fi

OUT="$ROOT/artifacts/worker-runtime/$ARCHIVE"
mkdir -p "$(dirname "$OUT")"
docker build --pull -f "$DOCKERFILE" -t "$IMAGE" "$ROOT/docker/expert-worker"
docker save -o "$OUT" "$IMAGE"
printf 'Backend: %s\nImage: %s\nArchive: %s\n' "$BACKEND" "$IMAGE" "$OUT"
printf 'Transfer the archive to the Worker host and run: docker load -i %s\n' "$ARCHIVE"
