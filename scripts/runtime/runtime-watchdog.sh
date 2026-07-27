#!/usr/bin/env bash
set -euo pipefail
umask 077

BASE_URL=${JARVIS_HEALTH_BASE_URL:-http://127.0.0.1:3000}
STATE_ROOT=${JARVIS_STATE_ROOT:-}
LOG_ROOT=${JARVIS_LOG_ROOT:-}
MAX_BYTES=${JARVIS_LOG_MAX_BYTES:-10485760}
KEEP=${JARVIS_LOG_KEEP:-5}
SCRIPT_DIRECTORY=$(/usr/bin/dirname "$0")

[[ "$BASE_URL" =~ ^http://127\.0\.0\.1:[0-9]{1,5}$ ]] || {
  printf '{"status":"failed","reason":"non_loopback_health_url"}\n'
  exit 64
}
[[ "$STATE_ROOT" == /* && -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] || {
  printf '{"status":"failed","reason":"invalid_state_root"}\n'
  exit 64
}
[[ "$LOG_ROOT" == /* && -d "$LOG_ROOT" && ! -L "$LOG_ROOT" ]] || {
  printf '{"status":"failed","reason":"invalid_log_root"}\n'
  exit 64
}

"$SCRIPT_DIRECTORY/rotate-logs.sh" \
  --log-dir "$LOG_ROOT" \
  --max-bytes "$MAX_BYTES" \
  --keep "$KEEP"

set +e
disk_result=$(
  "$SCRIPT_DIRECTORY/disk-guard.sh" \
    --path "$STATE_ROOT" \
    --warn-percent 20 \
    --critical-percent 10
)
disk_status=$?
set -e
case "$disk_status" in
  0) disk="healthy" ;;
  20) disk="warning" ;;
  10 | 11)
    printf '{"status":"blocked","livez":"skipped","readyz":"skipped","disk":"critical","action":"hold_new_work"}\n'
    exit 10
    ;;
  *)
    printf '{"status":"failed","reason":"disk_guard_failed"}\n'
    exit 1
    ;;
esac

if ! /usr/bin/curl \
  --fail \
  --silent \
  --output /dev/null \
  --max-time 5 \
  --proto '=http' \
  --noproxy '*' \
  "$BASE_URL/livez" 2>/dev/null; then
  printf '{"status":"failed","livez":"failed","readyz":"skipped","disk":"%s"}\n' "$disk"
  exit 1
fi

if ! /usr/bin/curl \
  --fail \
  --silent \
  --output /dev/null \
  --max-time 5 \
  --proto '=http' \
  --noproxy '*' \
  "$BASE_URL/readyz" 2>/dev/null; then
  printf '{"status":"not_ready","livez":"ok","readyz":"failed","disk":"%s"}\n' "$disk"
  exit 1
fi

printf '{"status":"ready","livez":"ok","readyz":"ok","disk":"%s"}\n' "$disk"
