#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo ./install-worker.sh worker-runtime-<version>.tar.gz" >&2
  exit 1
fi

ARCHIVE=${1:-}
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "Usage: $0 worker-runtime-<version>.tar.gz" >&2
  exit 2
fi

BASE=/opt/team-skill-hub-worker
ETC=/etc/team-skill-hub-worker
DATA=/var/lib/team-skill-hub-worker
VERSION=$(basename "$ARCHIVE" .tar.gz | sed 's/^worker-runtime-//')
[[ "$VERSION" =~ ^[A-Za-z0-9._+-]+$ ]] || { echo "Invalid archive version" >&2; exit 2; }

if ! getent group docker >/dev/null 2>&1; then
  echo "Docker group not found; install Docker Engine first." >&2
  exit 1
fi
if ! getent group expert-worker >/dev/null 2>&1; then groupadd --system expert-worker; fi
if ! id expert-worker >/dev/null 2>&1; then
  useradd --system --gid expert-worker --create-home --home-dir "$DATA" --shell /usr/sbin/nologin expert-worker
fi
usermod -g expert-worker -aG docker expert-worker

install -d -m 0755 "$BASE/releases/$VERSION"
install -d -o root -g expert-worker -m 0750 "$ETC" "$ETC/workers" "$ETC/instances"
install -d -o expert-worker -g expert-worker -m 0750 "$DATA"

tar -xzf "$ARCHIVE" -C "$BASE/releases/$VERSION"
chown -R root:root "$BASE/releases/$VERSION"
chmod -R go-w "$BASE/releases/$VERSION"
ln -sfn "$BASE/releases/$VERSION" "$BASE/current.new"
mv -Tf "$BASE/current.new" "$BASE/current"

install -m 0644 "$BASE/current/worker.env.example" "$ETC/worker.env.example"
chown root:root "$ETC/worker.env.example"

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

if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1 && systemctl show-environment >/dev/null 2>&1; then
  install -m 0644 "$BASE/current/team-skill-hub-worker@.service" /etc/systemd/system/team-skill-hub-worker@.service
  systemctl daemon-reload
  echo "Installed Worker runtime $VERSION (systemd detected)."
  echo "Next: $BASE/current/worker-control.sh init <instance>"
  echo "Then: systemctl enable --now team-skill-hub-worker@<instance>"
else
  echo "Installed Worker runtime $VERSION (no running systemd)."
  echo "Next: $BASE/current/worker-control.sh init <instance>"
  echo "Then: $BASE/current/worker-control.sh <instance> start"
fi
echo "Inventory: $BASE/current/worker-control.sh list"
echo "Security note: membership in the docker group effectively grants root-equivalent privileges. Use a dedicated trusted Worker host."
