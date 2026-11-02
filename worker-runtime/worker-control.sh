#!/usr/bin/env bash
set -Eeuo pipefail

BASE=${WORKER_RUNTIME_BASE:-/opt/team-skill-hub-worker/current}
HOST_ROOT=${WORKER_RUNTIME_HOST_ROOT:-$(dirname "$BASE")}
ETC=${WORKER_RUNTIME_ETC_ROOT:-/etc/team-skill-hub-worker}
DATA_ROOT=${WORKER_RUNTIME_DATA_ROOT:-/var/lib/team-skill-hub-worker}
WORKERS_DIR="$ETC/workers"
INSTANCES_DIR="$ETC/instances"
TEMPLATE="$ETC/worker.env.example"
WORKER_SCRIPT="$BASE/src/cli/expert-worker.js"
NODE=${WORKER_RUNTIME_NODE:-}
if [[ -z "$NODE" && -x "$HOST_ROOT/node" ]]; then NODE="$HOST_ROOT/node"; fi
if [[ -z "$NODE" ]]; then NODE=$(command -v node || true); fi
if [[ -z "$NODE" ]]; then
  for candidate in /usr/local/bin/node /usr/bin/node; do
    if [[ -x "$candidate" ]]; then NODE="$candidate"; break; fi
  done
fi

RUNUSER=${WORKER_RUNTIME_RUNUSER:-}
if [[ -z "$RUNUSER" ]]; then RUNUSER=$(command -v runuser || true); fi
if [[ -z "$RUNUSER" ]]; then
  for candidate in /usr/sbin/runuser /sbin/runuser; do
    if [[ -x "$candidate" ]]; then RUNUSER="$candidate"; break; fi
  done
fi

usage() {
  cat >&2 <<EOF
Usage:
  sudo $0 init <instance>
  sudo $0 list [--json]
  sudo $0 <instance> {start|stop|restart|status|logs}
EOF
  exit 2
}

require_root() {
  if [[ "${WORKER_RUNTIME_SKIP_ROOT_CHECK:-}" != "1" && $EUID -ne 0 ]]; then
    echo "Run as root/sudo." >&2
    exit 1
  fi
}

validate_instance() {
  local instance=${1:-}
  [[ "$instance" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
    echo "Invalid Worker instance: $instance" >&2
    return 1
  }
}

load_instance_context() {
  INSTANCE=$1
  validate_instance "$INSTANCE"
  CONFIG="$WORKERS_DIR/$INSTANCE.env"
  DATA="$DATA_ROOT/$INSTANCE"
  PID_FILE="$DATA/worker.pid"
  START_FILE="$DATA/worker.pid.start"
  LOG_FILE="$DATA/worker.log"
}

worker_start_time() {
  local pid=$1 cmd uid
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -r "/proc/$pid/stat" && -r "/proc/$pid/cmdline" && -r "/proc/$pid/environ" ]] || return 1
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline")
  [[ "$cmd" == *"$WORKER_SCRIPT"* ]] || return 1
  tr '\0' '\n' < "/proc/$pid/environ" | grep -Fxq "EXPERT_WORKER_INSTANCE=$INSTANCE" || return 1
  if id expert-worker >/dev/null 2>&1; then
    uid=$(stat -c %u "/proc/$pid")
    [[ "$uid" == "$(id -u expert-worker)" ]] || return 1
  fi
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

instance_status() {
  if pid=$(running_pid 2>/dev/null); then
    printf 'running\t%s\n' "$pid"
  elif [[ -e "$PID_FILE" || -e "$START_FILE" ]]; then
    printf 'stale-pid\t-\n'
  else
    printf 'stopped\t-\n'
  fi
}

config_is_valid_for_inventory() {
  local file=$1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*=.*$ ]] || return 1
  done < "$file"
}

env_value() {
  local file=$1 key=$2 value
  value=$(awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "=" {
      sub("^[[:space:]]*" key "=", "")
      print
      exit
    }
  ' "$file")
  value=${value%$'\r'}
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then value=${value:1:${#value}-2}; fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then value=${value:1:${#value}-2}; fi
  printf '%s' "$value"
}

init_instance() {
  local instance=$1
  load_instance_context "$instance"
  [[ -f "$TEMPLATE" ]] || { echo "Missing Worker template: $TEMPLATE" >&2; return 1; }
  [[ ! -e "$CONFIG" ]] || { echo "Worker instance already exists: $instance" >&2; return 1; }
  install -d -m 0750 "$WORKERS_DIR" "$INSTANCES_DIR/$instance/keys" "$DATA"
  install -m 0600 "$TEMPLATE" "$CONFIG"
  if [[ "${WORKER_RUNTIME_SKIP_ROOT_CHECK:-}" != "1" ]]; then
    chown root:root "$CONFIG"
    chown -R root:expert-worker "$INSTANCES_DIR/$instance"
    chown -R expert-worker:expert-worker "$DATA"
  fi
  echo "Created Worker instance $instance: $CONFIG"
  echo "Edit the config, then run: $0 $instance start"
}

list_instances() {
  local format=$1 file instance worker_id backend capability profiles state pid
  if [[ "$format" == "json" && ( -z "$NODE" || ! -x "$NODE" ) ]]; then
    echo "Node.js executable unavailable; set WORKER_RUNTIME_NODE or add node to PATH." >&2
    return 1
  fi
  mkdir -p "$WORKERS_DIR"
  local rows=()
  shopt -s nullglob
  local files=("$WORKERS_DIR"/*.env)
  shopt -u nullglob
  if [[ "$format" == "human" ]]; then
    printf '%-16s %-28s %-8s %-12s %-24s %-14s %s\n' INSTANCE WORKER_ID BACKEND CAPABILITY PROFILES STATUS PID
  else
    printf '['
  fi
  local first=1
  for file in "${files[@]}"; do
    instance=$(basename "$file" .env)
    if ! validate_instance "$instance" >/dev/null 2>&1 || ! config_is_valid_for_inventory "$file"; then
      worker_id="-"; backend="-"; capability="-"; profiles="-"; state="invalid-config"; pid="-"
    else
      worker_id=$(env_value "$file" EXPERT_WORKER_ID); worker_id=${worker_id:--}
      backend=$(env_value "$file" EXPERT_EXECUTOR_BACKEND); backend=${backend:-claude}
      capability=$(env_value "$file" EXPERT_CAPABILITY); capability=${capability:--}
      profiles=$(env_value "$file" EXPERT_RUNTIME_PROFILES); profiles=${profiles:--}
      load_instance_context "$instance"
      IFS=$'\t' read -r state pid < <(instance_status)
    fi
    if [[ "$format" == "human" ]]; then
      printf '%-16s %-28s %-8s %-12s %-24s %-14s %s\n' "$instance" "$worker_id" "$backend" "$capability" "$profiles" "$state" "$pid"
    else
      [[ $first -eq 1 ]] || printf ','
      first=0
      INSTANCE_JSON="$instance" WORKER_ID_JSON="$worker_id" BACKEND_JSON="$backend" CAPABILITY_JSON="$capability" PROFILES_JSON="$profiles" STATUS_JSON="$state" PID_JSON="$pid" \
        "$NODE" -e 'const e=process.env; const profiles=e.PROFILES_JSON==="-"?[]:e.PROFILES_JSON.split(",").map(x=>x.trim()).filter(Boolean); process.stdout.write(JSON.stringify({instance:e.INSTANCE_JSON,workerId:e.WORKER_ID_JSON==="-"?null:e.WORKER_ID_JSON,backend:e.BACKEND_JSON==="-"?null:e.BACKEND_JSON,capability:e.CAPABILITY_JSON==="-"?null:e.CAPABILITY_JSON,runtimeProfiles:profiles,status:e.STATUS_JSON,pid:e.PID_JSON==="-"?null:Number(e.PID_JSON)}))'
    fi
  done
  [[ "$format" == "human" ]] || printf ']\n'
}

prepare_instance_env() {
  [[ -f "$CONFIG" ]] || { echo "Missing Worker config: $CONFIG; run '$0 init $INSTANCE' first." >&2; return 1; }
  if [[ "${WORKER_RUNTIME_SKIP_ROOT_CHECK:-}" != "1" ]]; then
    [[ $(stat -c %u "$CONFIG") -eq 0 ]] || { echo "$CONFIG must be root-owned" >&2; return 1; }
    [[ $(stat -c %a "$CONFIG") == 600 ]] || { echo "$CONFIG must have permissions 600" >&2; return 1; }
  fi
  # Instance-owned settings must come from this instance config, not from a
  # parent shell that may previously have managed another Worker.
  unset \
    EXPERT_WORKER_INSTANCE \
    EXPERT_HUB_ADDRESS \
    EXPERT_WORKER_ID \
    EXPERT_WORKER_CREDENTIAL \
    EXPERT_WORKER_BOOTSTRAP_TOKEN \
    EXPERT_WORKER_CREDENTIAL_FILE \
    EXPERT_CAPABILITY \
    EXPERT_ID \
    EXPERT_SOURCE_PATH \
    EXPERT_REPOSITORY_ROOT \
    EXPERT_EXECUTOR_BACKEND \
    EXPERT_RUNTIME_PROFILES \
    EXPERT_DOCKER_IMAGE \
    EXPERT_DOCKER_NETWORK \
    EXPERT_DOCKER_SECCOMP_PROFILE \
    EXPERT_CODEX_AUTH_FILE \
    EXPERT_CODEX_CONFIG_FILE \
    EXPERT_CLAUDE_MODEL \
    EXPERT_CLAUDE_MAX_TURNS \
    EXPERT_MODEL_ENV_NAMES \
    EXPERT_MODEL_CREDENTIAL_REFS_JSON \
    EXPERT_MCP_URL \
    EXPERT_MCP_CREDENTIAL_FILES_JSON \
    EXPERT_GIT_CREDENTIALS_JSON \
    EXPERT_TLS_CA_PATH \
    EXPERT_TLS_CERT_PATH \
    EXPERT_TLS_KEY_PATH \
    EXPERT_ALLOW_MANAGED_PATH_OVERRIDES \
    EXPERT_HEARTBEAT_MS \
    EXPERT_POLL_MS \
    EXPERT_TASK_TIMEOUT_MS
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG"
  set +a
  export EXPERT_WORKER_INSTANCE="$INSTANCE"
  export EXPERT_WORKER_CREDENTIAL_FILE=${EXPERT_WORKER_CREDENTIAL_FILE:-"$DATA/worker-credential"}
  export EXPERT_SOURCE_PATH=${EXPERT_SOURCE_PATH:-"$DATA/source"}
  export EXPERT_REPOSITORY_ROOT=${EXPERT_REPOSITORY_ROOT:-"$DATA/repositories"}
}

matching_systemd_active() {
  [[ -d /run/systemd/system ]] &&
    command -v systemctl >/dev/null 2>&1 &&
    systemctl is-active --quiet "team-skill-hub-worker@$INSTANCE.service"
}

start_worker() {
  if matching_systemd_active; then
    echo "Worker $INSTANCE is managed by systemd; use systemctl team-skill-hub-worker@$INSTANCE.service." >&2
    return 1
  fi
  if pid=$(running_pid 2>/dev/null); then echo "Worker $INSTANCE already running (PID $pid)"; return; fi
  [[ -f "$WORKER_SCRIPT" && -n "$NODE" && -x "$NODE" && -n "$RUNUSER" && -x "$RUNUSER" ]] || { echo "Missing Node.js, runuser, or installed Worker Runtime." >&2; return 1; }
  prepare_instance_env
  install -d -m 0750 "$DATA"
  "$NODE" "$BASE/check-worker-config.js"
  rm -f "$PID_FILE" "$START_FILE"
  touch "$LOG_FILE"
  if [[ "${WORKER_RUNTIME_SKIP_ROOT_CHECK:-}" != "1" ]]; then
    chown expert-worker:expert-worker "$DATA" "$LOG_FILE"
  fi
  chmod 0600 "$LOG_FILE"
  "$RUNUSER" --user expert-worker --preserve-environment -- "$NODE" "$WORKER_SCRIPT" >> "$LOG_FILE" 2>&1 &
  local supervisor=$! child=""
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
  if [[ -z "$child" ]]; then echo "Worker did not start; see $LOG_FILE" >&2; wait "$supervisor" 2>/dev/null || true; return 1; fi
  printf '%s\n' "$child" > "$PID_FILE"
  worker_start_time "$child" > "$START_FILE"
  [[ "${WORKER_RUNTIME_SKIP_ROOT_CHECK:-}" == "1" ]] || chown expert-worker:expert-worker "$PID_FILE" "$START_FILE"
  chmod 0600 "$PID_FILE" "$START_FILE"
  echo "Worker $INSTANCE started (PID $child); logs: $LOG_FILE"
}

stop_worker() {
  local pid
  if matching_systemd_active; then
    echo "Worker $INSTANCE is managed by systemd; use systemctl team-skill-hub-worker@$INSTANCE.service." >&2
    return 1
  fi
  if ! pid=$(running_pid 2>/dev/null); then
    echo "Worker $INSTANCE not running"
    rm -f "$PID_FILE" "$START_FILE"
    return
  fi
  kill -TERM "$pid"
  for _ in $(seq 1 50); do
    running_pid >/dev/null 2>&1 || break
    sleep 0.2
  done
  if running_pid >/dev/null 2>&1; then echo "Worker PID $pid did not exit; inspect manually." >&2; return 1; fi
  rm -f "$PID_FILE" "$START_FILE"
  echo "Worker $INSTANCE stopped"
}

require_root

if [[ $# -ge 1 && "$1" == "init" ]]; then
  [[ $# -eq 2 ]] || usage
  init_instance "$2"
  exit
fi
if [[ $# -ge 1 && "$1" == "list" ]]; then
  if [[ $# -eq 1 ]]; then list_instances human; exit; fi
  [[ $# -eq 2 && "$2" == "--json" ]] || usage
  list_instances json
  exit
fi

[[ $# -eq 2 ]] || usage
load_instance_context "$1"
case "$2" in
  start) start_worker ;;
  stop) stop_worker ;;
  restart) stop_worker; start_worker ;;
  status)
    IFS=$'\t' read -r state pid < <(instance_status)
    echo "Worker $INSTANCE: $state${pid:+ (PID $pid)}"
    [[ "$state" == "running" ]] || exit 3
    ;;
  logs) [[ -f "$LOG_FILE" ]] || { echo "No log file yet: $LOG_FILE" >&2; exit 1; }; tail -n 100 -f "$LOG_FILE" ;;
  *) usage ;;
esac
