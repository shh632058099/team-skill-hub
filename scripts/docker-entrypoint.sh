#!/bin/sh
set -eu

SSH_KEY_SOURCE="${GITLAB_SSH_KEY_SOURCE:-/run/secrets/gitlab_ssh_key}"
KNOWN_HOSTS_SOURCE="${GITLAB_KNOWN_HOSTS_SOURCE:-/run/secrets/gitlab_known_hosts}"
SSH_KEY_TARGET="${GITLAB_SSH_KEY_TARGET:-/tmp/gitlab_ssh_key}"
KNOWN_HOSTS_TARGET="${GITLAB_KNOWN_HOSTS_TARGET:-/tmp/gitlab_known_hosts}"

if [ -f "$SSH_KEY_SOURCE" ]; then
  cp "$SSH_KEY_SOURCE" "$SSH_KEY_TARGET"
  chmod 0600 "$SSH_KEY_TARGET"
fi

if [ -f "$KNOWN_HOSTS_SOURCE" ]; then
  cp "$KNOWN_HOSTS_SOURCE" "$KNOWN_HOSTS_TARGET"
  chmod 0644 "$KNOWN_HOSTS_TARGET"
fi

exec "$@"
