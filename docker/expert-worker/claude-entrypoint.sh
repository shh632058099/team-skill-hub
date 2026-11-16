#!/bin/sh
set -eu

# Preserve shared-group write access for files created in workspace-write mode.
umask 0002

exec claude "$@"
