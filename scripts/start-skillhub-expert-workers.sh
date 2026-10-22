#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PROJECT_DIR=/mnt/d/wsl/.codex/workspace/skill-hub-workspace/team-skill-hub
LOG_FILE=/var/log/skillhub-expert-workers-startup.log
exec >>"$LOG_FILE" 2>&1
printf "\n[%s] Skill Hub worker startup requested\n" "$(date -Is)"

# WSL boot can precede Docker Desktop's Linux engine becoming available.
for attempt in $(seq 1 90); do
  if docker info >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 90 ]; then echo "Docker engine did not become available within 3 minutes."; exit 1; fi
  sleep 2
done

cd "$PROJECT_DIR"
if ! docker compose ps --status running --services | grep -qx team-skill-hub; then
  echo "Starting Team Skill Hub container."
  docker compose up -d team-skill-hub
fi
ready=0
for attempt in $(seq 1 90); do
  if curl -fsS --max-time 2 http://127.0.0.1:8080/health/ready >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then echo "Team Skill Hub did not become ready within 3 minutes."; exit 1; fi

start_worker() {
  local session="$1" launcher="$2" dead
  if tmux -L skillhub has-session -t "$session" 2>/dev/null; then
    dead=$(tmux -L skillhub display-message -p -t "$session" "#{pane_dead}" 2>/dev/null || echo 1)
    if [ "$dead" = 0 ]; then echo "Worker session $session already has a live pane."; return 0; fi
    echo "Replacing stale worker session $session."
    tmux -L skillhub kill-session -t "$session" || true
  fi
  echo "Starting worker session $session."
  tmux -L skillhub new-session -d -s "$session" "exec $launcher"
  sleep 1
  dead=$(tmux -L skillhub display-message -p -t "$session" "#{pane_dead}" 2>/dev/null || echo 1)
  if [ "$dead" != 0 ]; then
    echo "Worker launcher exited immediately: $session"
    tmux -L skillhub capture-pane -p -t "$session" 2>/dev/null | tail -30 || true
    return 1
  fi
}
start_worker ota-expert-worker /usr/local/bin/ota-expert-worker
start_worker code-review-expert-worker /usr/local/bin/review-expert-worker
printf "[%s] Worker startup check finished.\n" "$(date -Is)"
tmux -L skillhub list-sessions
