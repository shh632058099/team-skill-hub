#!/usr/bin/env bash
set -Eeuo pipefail

# Install the already-built runtime archive. This script does not clone the Hub source.
if [[ $EUID -ne 0 ]]; then echo "Run as root: sudo ./install-worker.sh [archive.tar.gz]" >&2; exit 1; fi
ARCHIVE=${1:-}
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then echo "Usage: $0 worker-runtime-<version>.tar.gz" >&2; exit 2; fi
BASE=/opt/team-skill-hub-worker
ETC=/etc/team-skill-hub-worker
DATA=/var/lib/team-skill-hub-worker
VERSION=$(basename "$ARCHIVE" .tar.gz | sed 's/^worker-runtime-//')
[[ "$VERSION" =~ ^[A-Za-z0-9._+-]+$ ]] || { echo "Invalid archive version" >&2; exit 2; }
if ! getent group docker >/dev/null 2>&1; then echo "Docker group not found; install Docker Engine first." >&2; exit 1; fi
if ! getent group expert-worker >/dev/null 2>&1; then groupadd --system expert-worker; fi
if ! id expert-worker >/dev/null 2>&1; then useradd --system --gid expert-worker --create-home --home-dir "$DATA" --shell /usr/sbin/nologin expert-worker; fi
usermod -g expert-worker -aG docker expert-worker
install -d -m 0755 "$BASE/releases/$VERSION"
install -d -o root -g expert-worker -m 0750 "$ETC" "$ETC/keys"
install -d -o expert-worker -g expert-worker -m 0750 "$DATA"
tar -xzf "$ARCHIVE" -C "$BASE/releases/$VERSION"
chown -R root:root "$BASE/releases/$VERSION"
chmod -R go-w "$BASE/releases/$VERSION"
ln -sfn "$BASE/releases/$VERSION" "$BASE/current.new"
mv -Tf "$BASE/current.new" "$BASE/current"
if [[ ! -f "$ETC/worker.env" ]]; then install -m 0600 "$BASE/current/worker.env.example" "$ETC/worker.env"; chown root:root "$ETC/worker.env"; echo "Created $ETC/worker.env; edit it before starting the service."; fi
install -m 0644 "$BASE/current/team-skill-hub-worker.service" /etc/systemd/system/team-skill-hub-worker.service
systemctl daemon-reload
echo "Installed Worker runtime $VERSION. Configure $ETC/worker.env, load the matching execution image, then run: systemctl enable --now team-skill-hub-worker"
echo "Security note: membership in the docker group effectively grants root-equivalent privileges. Use a dedicated trusted Worker host."
