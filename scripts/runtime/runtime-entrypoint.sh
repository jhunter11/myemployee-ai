#!/usr/bin/env bash
set -euo pipefail
umask 077

fail_configuration() {
  printf 'jarvis runtime configuration rejected: %s\n' "$1" >&2
  exit 64
}

(($# == 2)) || fail_configuration "expected absolute Node and server paths"
NODE_BIN=$1
SERVER_FILE=$2
OPERATOR_HOME=${HOME:-}

[[ "${HOST:-}" == "127.0.0.1" ]] || fail_configuration "HOST must remain loopback-only"
[[ "${PORT:-}" =~ ^[0-9]+$ ]] || fail_configuration "PORT must be numeric"
((PORT >= 1 && PORT <= 65535)) || fail_configuration "PORT is outside the valid range"
[[ "$OPERATOR_HOME" == /* && -d "$OPERATOR_HOME" ]] || \
  fail_configuration "HOME must be an absolute available directory"

AGENCY_INITIAL_POSTURE=${JARVIS_AGENCY_INITIAL_POSTURE:-paused}
case "$AGENCY_INITIAL_POSTURE" in
  active | paused) ;;
  *) fail_configuration "agency initial posture must be active or paused" ;;
esac

for variable_name in \
  JARVIS_ROOT \
  JARVIS_STATE_ROOT \
  DB_PATH \
  JARVIS_CLIENT_ROOT \
  JARVIS_WORKSPACE_ROOT \
  JARVIS_GRAPH_ROOT \
  JARVIS_PERSONAL_MEMORY_ROOT; do
  value=${!variable_name:-}
  [[ "$value" == /* ]] || fail_configuration "$variable_name must be absolute"
done

[[ -d "$JARVIS_ROOT" && ! -L "$JARVIS_ROOT" ]] || fail_configuration "release root is unavailable"
EXPECTED_SERVER="$JARVIS_ROOT/dist/src/gateway/server.js"
[[ "$SERVER_FILE" == "$EXPECTED_SERVER" ]] || fail_configuration "server path is outside the release"
[[ -f "$SERVER_FILE" && ! -L "$SERVER_FILE" ]] || fail_configuration "server file is unavailable"
[[ "$NODE_BIN" == /* && -x "$NODE_BIN" && ! -L "$NODE_BIN" ]] || \
  fail_configuration "Node executable is unavailable or indirect"

STATE_ROOT=$JARVIS_STATE_ROOT
[[ "$STATE_ROOT" == /* && -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] || \
  fail_configuration "state root is unavailable"
RUNTIME_RELEASES_ROOT=$(/usr/bin/dirname "$JARVIS_ROOT")
RUNTIME_INSTALL_ROOT=$(/usr/bin/dirname "$RUNTIME_RELEASES_ROOT")
[[ "$(/usr/bin/basename "$RUNTIME_RELEASES_ROOT")" == releases && \
   "$STATE_ROOT" == "$RUNTIME_INSTALL_ROOT/state" ]] || \
  fail_configuration "state root must belong to the release install root"
[[ "$DB_PATH" == "$STATE_ROOT/jarvis.sqlite" && \
   "$JARVIS_CLIENT_ROOT" == "$STATE_ROOT/clients" && \
   "$JARVIS_WORKSPACE_ROOT" == "$STATE_ROOT/workspaces" && \
   "$JARVIS_GRAPH_ROOT" == "$STATE_ROOT/memory/graph" && \
   "$JARVIS_PERSONAL_MEMORY_ROOT" == "$STATE_ROOT/memory/personal" ]] || \
  fail_configuration "runtime paths must use the exact private state layout"

private_directory() {
  local directory=$1
  local mode
  [[ -d "$directory" && ! -L "$directory" && -w "$directory" ]] || return 1
  mode=$(/usr/bin/stat -f '%Lp' "$directory" 2>/dev/null) || return 1
  [[ "$mode" == 700 ]]
}

for private_directory_path in \
  "$STATE_ROOT" \
  "$JARVIS_CLIENT_ROOT" \
  "$JARVIS_WORKSPACE_ROOT" \
  "$STATE_ROOT/memory" \
  "$JARVIS_GRAPH_ROOT" \
  "$JARVIS_PERSONAL_MEMORY_ROOT"; do
  private_directory "$private_directory_path" || \
    fail_configuration "runtime directory is not private"
done
for writable_directory in \
  "$(/usr/bin/dirname "$DB_PATH")" \
  "$JARVIS_CLIENT_ROOT" \
  "$JARVIS_WORKSPACE_ROOT" \
  "$JARVIS_GRAPH_ROOT" \
  "$JARVIS_PERSONAL_MEMORY_ROOT"; do
  [[ -d "$writable_directory" && ! -L "$writable_directory" && -w "$writable_directory" ]] || \
    fail_configuration "runtime directory is unavailable"
done

for database_path in "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do
  if [[ -e "$database_path" || -L "$database_path" ]]; then
    [[ -f "$database_path" && ! -L "$database_path" ]] || \
      fail_configuration "database state is unavailable or indirect"
    database_mode=$(/usr/bin/stat -f '%Lp' "$database_path" 2>/dev/null) || \
      fail_configuration "database state mode is unavailable"
    [[ "$database_mode" == 600 ]] || fail_configuration "database state is not private"
  fi
done

DISK_GUARD="$JARVIS_ROOT/scripts/runtime/disk-guard.sh"
[[ -x "$DISK_GUARD" && ! -L "$DISK_GUARD" ]] || fail_configuration "disk guard is unavailable"
set +e
disk_result=$(
  "$DISK_GUARD" --path "$STATE_ROOT" --warn-percent 20 --critical-percent 10
)
disk_status=$?
set -e
case "$disk_status" in
  0) ;;
  20) printf '%s\n' "$disk_result" >&2 ;;
  10 | 11)
    printf '%s\n' "$disk_result" >&2
    # A clean exit prevents launchd from crash-looping and consuming the last disk space.
    exit 0
    ;;
  *) fail_configuration "disk guard failed unexpectedly" ;;
esac

TELEGRAM_ENV=()
case "${JARVIS_TELEGRAM_ENABLED:-}" in
  "") ;;
  1)
    [[ "${JARVIS_TELEGRAM_USER_ID:-}" =~ ^[1-9][0-9]{0,15}$ ]] || \
      fail_configuration "Telegram user ID is invalid"
    [[ "${JARVIS_TELEGRAM_CHAT_ID:-}" =~ ^[1-9][0-9]{0,15}$ ]] || \
      fail_configuration "Telegram private chat ID is invalid"
    [[ "${JARVIS_TELEGRAM_KEYCHAIN_SERVICE:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$ ]] || \
      fail_configuration "Telegram Keychain service is invalid"
    [[ "${JARVIS_TELEGRAM_KEYCHAIN_ACCOUNT:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$ ]] || \
      fail_configuration "Telegram Keychain account is invalid"
    TELEGRAM_ENV=(
      JARVIS_TELEGRAM_ENABLED=1
      "JARVIS_TELEGRAM_USER_ID=$JARVIS_TELEGRAM_USER_ID"
      "JARVIS_TELEGRAM_CHAT_ID=$JARVIS_TELEGRAM_CHAT_ID"
      "JARVIS_TELEGRAM_KEYCHAIN_SERVICE=$JARVIS_TELEGRAM_KEYCHAIN_SERVICE"
      "JARVIS_TELEGRAM_KEYCHAIN_ACCOUNT=$JARVIS_TELEGRAM_KEYCHAIN_ACCOUNT"
    )
    ;;
  *) fail_configuration "Telegram enable flag is invalid" ;;
esac

exec /usr/bin/env -i \
  NODE_ENV=production \
  HOME="$OPERATOR_HOME" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  LANG=C.UTF-8 \
  HOST="$HOST" \
  PORT="$PORT" \
  JARVIS_ROOT="$JARVIS_ROOT" \
  JARVIS_STATE_ROOT="$STATE_ROOT" \
  DB_PATH="$DB_PATH" \
  JARVIS_CLIENT_ROOT="$JARVIS_CLIENT_ROOT" \
  JARVIS_WORKSPACE_ROOT="$JARVIS_WORKSPACE_ROOT" \
  JARVIS_GRAPH_ROOT="$JARVIS_GRAPH_ROOT" \
  JARVIS_PERSONAL_MEMORY_ROOT="$JARVIS_PERSONAL_MEMORY_ROOT" \
  JARVIS_AGENCY_INITIAL_POSTURE="$AGENCY_INITIAL_POSTURE" \
  "${TELEGRAM_ENV[@]}" \
  GRAPHIFY_QUERY_LOG_DISABLE=1 \
  NO_PROXY=127.0.0.1,localhost \
  "$NODE_BIN" "$SERVER_FILE"
