#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BACKEND=${1:-claude}
VERSION=${2:-0.1.0}
BUILD_MODE=${BUILD_MODE:-auto}
BASE_IMAGE=${BASE_IMAGE:-node:24-bullseye-slim}
DEBIAN_SNAPSHOT=${DEBIAN_SNAPSHOT:-20260824T000000Z}

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

select_build_mode() {
  case "$BUILD_MODE" in
    standard|legacy) printf '%s\n' "$BUILD_MODE" ;;
    auto)
      local server_version major minor
      if ! server_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || [[ -z "$server_version" ]]; then
        printf 'Unable to detect Docker Server version. Set BUILD_MODE=standard or BUILD_MODE=legacy to override.\n' >&2
        return 1
      fi
      if [[ ! "$server_version" =~ ^v?([0-9]+)\.([0-9]+)(\.([0-9]+))?([+.-][A-Za-z0-9][A-Za-z0-9.+-]*)?$ ]]; then
        printf 'Unable to parse Docker Server version: %s. Set BUILD_MODE=standard or BUILD_MODE=legacy to override.\n' "$server_version" >&2
        return 1
      fi
      major=${BASH_REMATCH[1]}
      minor=${BASH_REMATCH[2]}
      if (( major < 20 || (major == 20 && minor < 10) )); then
        printf 'legacy\n'
      else
        printf 'standard\n'
      fi
      ;;
    *)
      printf 'Invalid BUILD_MODE: %s (expected auto, standard, or legacy)\n' "$BUILD_MODE" >&2
      return 2
      ;;
  esac
}

MODE=$(select_build_mode)
if [[ "$MODE" == legacy && ! "$DEBIAN_SNAPSHOT" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  printf 'Invalid DEBIAN_SNAPSHOT: %s (expected YYYYMMDDThhmmssZ)\n' "$DEBIAN_SNAPSHOT" >&2
  exit 2
fi
printf 'Build mode: %s\n' "$MODE"

OUT="$ROOT/artifacts/worker-runtime/$ARCHIVE"
mkdir -p "$(dirname "$OUT")"

if [[ "$MODE" == standard ]]; then
  # Preserve the established modern-host build behavior.
  docker build --pull -f "$DOCKERFILE" -t "$IMAGE" "$ROOT/docker/expert-worker"
else
  TEMP_DIR=$(mktemp -d)
  cleanup() { rm -rf "$TEMP_DIR"; }
  trap cleanup EXIT
  GENERATED_DOCKERFILE="$TEMP_DIR/Dockerfile.legacy"
  cp "$ROOT/docker/expert-worker/entrypoint.sh" "$TEMP_DIR/entrypoint.sh"

  # Derive the compatibility Dockerfile from the canonical source so CLI
  # versions, package installs, user, entrypoint and CMD cannot drift.
  python3 - "$DOCKERFILE" "$GENERATED_DOCKERFILE" "$BASE_IMAGE" "$DEBIAN_SNAPSHOT" <<'PYGEN'
import pathlib, sys
source, target, base_image, snapshot = sys.argv[1:]
text = pathlib.Path(source).read_text()
lines = text.splitlines()
if not lines or not lines[0].startswith("FROM "):
    raise SystemExit(f"Expected Dockerfile to start with FROM: {source}")
lines[0] = f"FROM {base_image}"
text = "\n".join(lines) + "\n"
lines = text.splitlines()
for index, line in enumerate(lines):
    if "&& sed -i 's|http://deb.debian.org|https://deb.debian.org|g'" in line:
        if index + 1 >= len(lines) or "apt-get -o Acquire::https::CaInfo=/tmp/ca-bundle.crt update" not in lines[index + 1]:
            raise SystemExit("Unexpected apt source setup; refusing unsafe legacy conversion")
        lines[index:index + 2] = [
            "    && printf 'deb http://snapshot.debian.org/archive/debian/" + snapshot + " bullseye main\\ndeb http://snapshot.debian.org/archive/debian-security/" + snapshot + " bullseye-security main\\n' > /etc/apt/sources.list \\",
            "    && rm -f /etc/apt/sources.list.d/debian.sources \\",
            "    && apt-get -o Acquire::Check-Valid-Until=false update \\",
        ]
        break
else:
    raise SystemExit("Could not locate expected Debian bookworm apt source setup in Dockerfile")
text = "\n".join(lines) + "\n"
text = text.replace("apt-get -o Acquire::https::CaInfo=/tmp/ca-bundle.crt install", "apt-get -o Acquire::Check-Valid-Until=false install")
pathlib.Path(target).write_text(text)
PYGEN

  if ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
    if ! docker pull "$BASE_IMAGE"; then
      printf 'Unable to pull base image %s. Set BASE_IMAGE to an accessible registry mirror tag.\n' "$BASE_IMAGE" >&2
      exit 1
    fi
  fi

  docker build -f "$GENERATED_DOCKERFILE" -t "$IMAGE" "$TEMP_DIR"
  docker run --rm "$IMAGE"
fi

docker save -o "$OUT" "$IMAGE"
printf 'Backend: %s\nImage: %s\nArchive: %s\n' "$BACKEND" "$IMAGE" "$OUT"
printf 'Transfer the archive to the Worker host and run: docker load -i %s\n' "$ARCHIVE"
