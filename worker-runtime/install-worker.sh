#!/usr/bin/env bash
set -Eeuo pipefail

# Prefer system administration paths for root installs, but preserve the
# invoking user's PATH precedence (e.g. nvm Node 24) in unprivileged mode.
if [[ $EUID -eq 0 ]]; then
  export PATH="/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
else
  export PATH="${PATH:-}:/usr/sbin:/usr/bin:/sbin:/bin"
fi

ARCHIVE=${1:-}
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "Usage: $0 worker-runtime-<version>.tar.gz [--install-dir PATH] [--no-systemd]" >&2
  exit 2
fi
shift
if [[ $EUID -eq 0 ]]; then INSTALL_DIR=/opt/team-skill-hub-worker; else INSTALL_DIR="$HOME/team-skill-hub-worker"; fi
NO_SYSTEMD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--install-dir requires a non-empty path" >&2; exit 2; }
      INSTALL_DIR=$2
      shift 2
      ;;
    --no-systemd)
      NO_SYSTEMD=1
      shift
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$INSTALL_DIR" ]] || { echo "Install directory cannot be empty" >&2; exit 2; }
if [[ "$INSTALL_DIR" == *'"'* || "$INSTALL_DIR" == *'%'* || "$INSTALL_DIR" == *$'\n'* ]]; then
  echo "Install directory cannot contain double quotes, percent signs, or newlines (systemd path syntax)." >&2
  exit 2
fi
mkdir -p "$INSTALL_DIR"
BASE=$(cd "$INSTALL_DIR" && pwd -P)
VERSION=$(basename "$ARCHIVE" .tar.gz | sed 's/^worker-runtime-//')
[[ "$VERSION" =~ ^[A-Za-z0-9._+-]+$ ]] || { echo "Invalid archive version" >&2; exit 2; }

# Non-root + --no-systemd selects a fully unprivileged installation.
if [[ $EUID -ne 0 ]]; then
  if [[ $NO_SYSTEMD -ne 1 ]]; then
    printf 'Non-root installation requires --no-systemd. Example:\n  %s %q --install-dir "$HOME/team-skill-hub-worker" --no-systemd\n' "$0" "$ARCHIVE" >&2
    exit 1
  fi
  if [[ ! -w "$BASE" ]]; then
    echo "Install directory is not writable by $(id -un): $BASE" >&2
    exit 1
  fi
  DOCKER_BIN=${WORKER_RUNTIME_DOCKER:-$(command -v docker || true)}
  if [[ -z "$DOCKER_BIN" || ! -x "$DOCKER_BIN" ]] || ! "$DOCKER_BIN" info >/dev/null 2>&1; then
    cat >&2 <<EOF
Docker is not accessible to the current user.
Confirm this account is in the docker group and that the Docker daemon is running:
  id -nG
  docker info
If you were just added to the docker group, log out and back in (or start a new login session).
The installer will not modify system group membership.
EOF
    exit 1
  fi
  resolve_user_node() {
    local candidate version
    local candidates=()
    if [[ -n "${WORKER_RUNTIME_NODE:-}" ]]; then
      candidates=("$WORKER_RUNTIME_NODE")
    else
      candidate=$(command -v node || true)
      [[ -z "$candidate" ]] || candidates+=("$candidate")
      candidates+=(/usr/local/bin/node /usr/bin/node)
    fi
    for candidate in "${candidates[@]}"; do
      [[ -n "$candidate" && -x "$candidate" ]] || continue
      version=$("$candidate" --version 2>/dev/null || true)
      if [[ "$version" =~ ^v24\. ]]; then
        NODE_BIN=$(readlink -f "$candidate")
        return 0
      fi
    done
    return 1
  }
  if ! resolve_user_node; then
    echo "Node.js 24 executable unavailable to current user. Install Node.js 24 or set WORKER_RUNTIME_NODE." >&2
    exit 1
  fi

  ETC="$BASE/etc/team-skill-hub-worker"
  DATA="$BASE/data"
  mkdir -p "$BASE/releases/$VERSION" "$ETC/workers" "$ETC/instances" "$DATA"
  ln -sfn "$NODE_BIN" "$BASE/node.new"
  mv -Tf "$BASE/node.new" "$BASE/node"
  tar -xzf "$ARCHIVE" -C "$BASE/releases/$VERSION"
  ln -sfn "$BASE/releases/$VERSION" "$BASE/current.new"
  mv -Tf "$BASE/current.new" "$BASE/current"
  install -m 0644 "$BASE/current/worker.env.example" "$ETC/worker.env.example"
  printf 'user\n' > "$BASE/.worker-runtime-mode"
  printf '%s\n' "$ETC" > "$BASE/.worker-runtime-etc"
  printf '%s\n' "$DATA" > "$BASE/.worker-runtime-data"
  touch "$BASE/.no-systemd"
  chmod 0600 "$BASE/.worker-runtime-mode" "$BASE/.worker-runtime-etc" "$BASE/.worker-runtime-data"
  chmod 0644 "$BASE/.no-systemd"
  echo "Installed Worker runtime $VERSION (unprivileged user mode; systemd disabled)."
  echo "Next: $BASE/current/worker-control.sh init <instance>"
  echo "Then: $BASE/current/worker-control.sh <instance> start"
  echo "Inventory: $BASE/current/worker-control.sh list"
  exit 0
fi

ETC=/etc/team-skill-hub-worker
DATA=/var/lib/team-skill-hub-worker
SYSTEMD_RUNNING=0
if [[ $NO_SYSTEMD -eq 0 ]] && [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1 && systemctl show-environment >/dev/null 2>&1; then
  SYSTEMD_RUNNING=1
fi
LEGACY_UNIT=/etc/systemd/system/team-skill-hub-worker.service
if [[ $SYSTEMD_RUNNING -eq 1 && -e "$LEGACY_UNIT" ]]; then
  if systemctl is-active --quiet team-skill-hub-worker.service || systemctl is-enabled --quiet team-skill-hub-worker.service; then
    cat >&2 <<EOF
Legacy team-skill-hub-worker.service is still active or enabled.
Stop and disable it before installing the multi-instance runtime:
  systemctl disable --now team-skill-hub-worker.service
Then rerun this installer and create named Worker instances.
EOF
    exit 3
  fi
fi

if ! getent group docker >/dev/null 2>&1; then
  echo "Docker group not found; install Docker Engine first." >&2
  exit 1
fi
if ! getent group expert-worker >/dev/null 2>&1; then groupadd --system expert-worker; fi
if ! id expert-worker >/dev/null 2>&1; then
  useradd --system --gid expert-worker --create-home --home-dir "$DATA" --shell /usr/sbin/nologin expert-worker
fi
usermod -g expert-worker -aG docker expert-worker

resolve_node() {
  local candidate version
  local candidates=()
  if [[ -n "${WORKER_RUNTIME_NODE:-}" ]]; then
    candidates=("$WORKER_RUNTIME_NODE")
  else
    candidates=(/usr/local/bin/node /usr/bin/node)
    candidate=$(command -v node || true)
    [[ -z "$candidate" ]] || candidates+=("$candidate")
  fi
  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    version=$(runuser --user expert-worker -- "$candidate" --version 2>/dev/null || true)
    if [[ "$version" =~ ^v24\. ]]; then
      NODE_BIN=$(readlink -f "$candidate")
      return 0
    fi
  done
  return 1
}
if ! resolve_node; then
  echo "Node.js 24 executable unavailable to expert-worker. Install system-wide Node 24 or set WORKER_RUNTIME_NODE to an accessible executable." >&2
  exit 1
fi

install -d -m 0755 "$BASE/releases/$VERSION"
install -d -o root -g expert-worker -m 0750 "$ETC" "$ETC/workers" "$ETC/instances"
install -d -o expert-worker -g expert-worker -m 0750 "$DATA"
ln -sfn "$NODE_BIN" "$BASE/node.new"
mv -Tf "$BASE/node.new" "$BASE/node"
chown -h root:root "$BASE/node"

tar -xzf "$ARCHIVE" -C "$BASE/releases/$VERSION"
chown -R root:root "$BASE/releases/$VERSION"
chmod -R go-w "$BASE/releases/$VERSION"
ln -sfn "$BASE/releases/$VERSION" "$BASE/current.new"
mv -Tf "$BASE/current.new" "$BASE/current"

install -m 0644 "$BASE/current/worker.env.example" "$ETC/worker.env.example"
chown root:root "$ETC/worker.env.example"

if [[ $NO_SYSTEMD -eq 0 && -e "$LEGACY_UNIT" ]]; then
  rm -f "$LEGACY_UNIT" /etc/systemd/system/multi-user.target.wants/team-skill-hub-worker.service
  echo "Removed inactive legacy systemd unit: $LEGACY_UNIT" >&2
fi

if [[ -e "$ETC/worker.env" ]]; then
  cat >&2 <<EOF
Legacy single-worker configuration detected:
$ETC/worker.env

This runtime no longer reads that file.
Create an instance with:
  $BASE/current/worker-control.sh init <instance>
Then migrate reviewed settings to:
  $ETC/workers/<instance>.env
EOF
fi

if [[ $SYSTEMD_RUNNING -eq 1 ]]; then
  rm -f "$BASE/.no-systemd"
  escaped_base=${BASE//\\/\\\\}
  escaped_base=${escaped_base//&/\\&}
  escaped_base=${escaped_base//|/\\|}
  sed "s|/opt/team-skill-hub-worker|$escaped_base|g" "$BASE/current/team-skill-hub-worker@.service" > /etc/systemd/system/team-skill-hub-worker@.service.new
  chmod 0644 /etc/systemd/system/team-skill-hub-worker@.service.new
  mv -f /etc/systemd/system/team-skill-hub-worker@.service.new /etc/systemd/system/team-skill-hub-worker@.service
  systemctl daemon-reload
  echo "Installed Worker runtime $VERSION (systemd mode)."
  echo "Next: $BASE/current/worker-control.sh init <instance>"
  echo "Then: systemctl enable --now team-skill-hub-worker@<instance>"
else
  if [[ $NO_SYSTEMD -eq 1 ]]; then
    touch "$BASE/.no-systemd"
    chmod 0644 "$BASE/.no-systemd"
    echo "Installed Worker runtime $VERSION (systemd explicitly disabled)."
  else
    rm -f "$BASE/.no-systemd"
    echo "Installed Worker runtime $VERSION (no running systemd)."
  fi
  echo "Next: $BASE/current/worker-control.sh init <instance>"
  echo "Then: $BASE/current/worker-control.sh <instance> start"
fi
# A privileged reinstall converts any previous user-mode install back to system mode.
rm -f "$BASE/.worker-runtime-mode" "$BASE/.worker-runtime-etc" "$BASE/.worker-runtime-data"
echo "Inventory: $BASE/current/worker-control.sh list"
echo "Security note: membership in the docker group effectively grants root-equivalent privileges. Use a dedicated trusted Worker host."
