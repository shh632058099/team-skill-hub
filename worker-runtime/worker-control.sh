#!/usr/bin/env bash
set -Eeuo pipefail

# Manual Worker process manager for Linux hosts without a running systemd.
# Must run as root to read the protected worker.env and drop privileges.
BASE=/opt/team-skill-hub-worker/current
ETC=/etc/team-skill-hub-worker
DATA=/var/lib/team-skill-hub-worker
PID_FILE="$DATA/worker.pid"
START_FILE="$DATA/worker.pid.start"
LOG_FILE="$DATA/worker.log"
WORKER_SCRIPT="$BASE/src/cli/expert-worker.js"
NODE=$(command -v node || true)

usage() { echo "Usage: sudo $0 {start|stop|restart|status|logs}" >&2; exit 2; }
[[ $# -eq 1 ]] || usage
case "$1" in start|stop|restart|status|logs) ;; *) usage ;; esac
[[ $EUID -eq 0 ]] || { echo "Run as root: sudo $0 $1" >&2; exit 1; }

# Avoid a second instance beside the systemd-managed daemon.
if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet team-skill-hub-worker.service; then
  echo "Worker is managed by systemd; use systemctl and journalctl instead." >&2
  exit 1
fi

# Check both identity and start time, so a stale PID file cannot kill an unrelated process.
worker_start_time() {
  local pid=$1 cmd uid
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -r "/proc/$pid/stat" && -r "/proc/$pid/cmdline" ]] || return 1
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline")
  [[ "$cmd" == *"$WORKER_SCRIPT"* ]] || return 1
  uid=$(stat -c %u "/proc/$pid")
  [[ "$uid" == "$(id -u expert-worker)" ]] || return 1
  # /proc/[pid]/stat field 22, after executable in parentheses.
  awk '{print $22}' "/proc/$pid/stat"
}

running_pid() {
  [[ -r "$PID_FILE" && -r "$START_FILE" ]] || return 1
  local pid expected observed
  pid=$(cat "$PID_FILE")
  expected=$(cat "$START_FILE")
  observed=$(worker_start_time "$pid") || return 1
  [[ "$observed" == "$expected" ]] || return 1
  printf '%s\n' "$pid"
}

start_worker() {
  if pid=$(running_pid); then echo "Worker already running (PID $pid)"; return; fi
  [[ -f "$ETC/worker.env" && -f "$WORKER_SCRIPT" && -n "$NODE" && -x "$NODE" ]] || {
    echo "Missing worker.env, Node.js at $NODE or installed Runtime." >&2; return 1;
  }
  [[ $(stat -c %u "$ETC/worker.env") -eq 0 ]] || { echo "worker.env must be root-owned" >&2; return 1; }
  [[ $(stat -c %a "$ETC/worker.env") == 600 ]] || { echo "worker.env must have permissions 600" >&2; return 1; }
  install -d -o expert-worker -g expert-worker -m 0750 "$DATA"
  # Run the config checker with the same protected environment used by the daemon.
  # worker.env must only be edited by the trusted admin; sourcing is intentional here.
  set -a
  # shellcheck disable=SC1090
  source "$ETC/worker.env"
  set +a
  "$NODE" "$BASE/check-worker-config.js"
  rm -f "$PID_FILE" "$START_FILE"
  touch "$LOG_FILE"
  chown expert-worker:expert-worker "$LOG_FILE"
  chmod 0600 "$LOG_FILE"
  # runuser --preserve-environment allows the unprivileged Worker to receive the
  # approved env file, but keeps the protected file itself root-only.
  runuser --user expert-worker --preserve-environment -- "$NODE" "$WORKER_SCRIPT" >> "$LOG_FILE" 2>&1 &
  local supervisor=$!
  # runuser is a wrapper: capture its actual node child PID for safe stop/status.
  local child=""
  for _ in $(seq 1 40); do
    if [[ -r "/proc/$supervisor/task/$supervisor/children" ]]; then
      for candidate in $(cat "/proc/$supervisor/task/$supervisor/children"); do
        if worker_start_time "$candidate" >/dev/null 2>&1; then child=$candidate; break; fi
      done
    fi
    [[ -n "$child" ]] && break
    child=""
    kill -0 "$supervisor" 2>/dev/null || break
    sleep 0.1
  done
  if [[ -z "$child" ]]; then
    echo "Worker did not start; see $LOG_FILE" >&2
    wait "$supervisor" 2>/dev/null || true
    return 1
  fi
  printf '%s\n' "$child" > "$PID_FILE"
  worker_start_time "$child" > "$START_FILE"
  chown expert-worker:expert-worker "$PID_FILE" "$START_FILE"
  chmod 0600 "$PID_FILE" "$START_FILE"
  echo "Worker started (PID $child); logs: $LOG_FILE"
}

stop_worker() {
  local pid
  if ! pid=$(running_pid); then echo "Worker not running"; rm -f "$PID_FILE" "$START_FILE"; return; fi
  kill -TERM "$pid"
  for _ in $(seq 1 50); do
    if ! running_pid >/dev/null; then break; fi
    sleep 0.2
  done
  if running_pid >/dev/null; then
    echo "Worker PID $pid did not exit; inspect it manually (no forced kill)." >&2
    return 1
  fi
  rm -f "$PID_FILE" "$START_FILE"
  echo "Worker stopped"
}

case "$1" in
  start) start_worker ;;
  stop) stop_worker ;;
  restart) stop_worker; start_worker ;;
  status) if pid=$(running_pid); then echo "Worker running (PID $pid)"; else echo "Worker not running"; exit 3; fi ;;
  logs) [[ -f "$LOG_FILE" ]] || { echo "No log file yet: $LOG_FILE"; exit 1; }; tail -n 100 -f "$LOG_FILE" ;;
esac
