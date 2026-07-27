#!/usr/bin/env bash
set -euo pipefail
umask 077

INSTALL_ROOT="${HOME}/Library/Application Support/Jarvis"
LAUNCH_AGENTS_DIRECTORY="${HOME}/Library/LaunchAgents"
PORT=3000

usage() {
  echo "usage: runtime-audit.sh [--install-root PATH] [--launch-agents-dir PATH] [--port PORT]" >&2
  exit 64
}

while (($# > 0)); do
  case "$1" in
    --install-root)
      (($# >= 2)) || usage
      INSTALL_ROOT=$2
      shift 2
      ;;
    --launch-agents-dir)
      (($# >= 2)) || usage
      LAUNCH_AGENTS_DIRECTORY=$2
      shift 2
      ;;
    --port)
      (($# >= 2)) || usage
      PORT=$2
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$INSTALL_ROOT" == /* && "$LAUNCH_AGENTS_DIRECTORY" == /* ]] || usage
[[ "$PORT" =~ ^[0-9]+$ ]] || usage
((PORT >= 1 && PORT <= 65535)) || usage

GATEWAY_PLIST="$LAUNCH_AGENTS_DIRECTORY/com.aiagency.jarvis.gateway.plist"
WATCHDOG_PLIST="$LAUNCH_AGENTS_DIRECTORY/com.aiagency.jarvis.watchdog.plist"
STATE_ROOT="$INSTALL_ROOT/state"
LOG_ROOT="$INSTALL_ROOT/logs"

PLISTS=fail
LOOPBACK_CONFIG=fail
IMMUTABLE_RELEASE=fail
SECURE_STATE=fail
GATEWAY_LOADED=fail
CAFFEINATE_SUPERVISOR=fail
LOOPBACK_LISTENER=fail
READINESS=fail
DISK_GUARD=fail
RELEASE_ROOT=""
CONFIGURED_STATE_PATHS=fail

contained_release_symlinks() {
  local release_root=$1
  /usr/bin/find "$release_root" -type l -exec /bin/bash -c '
    root=$(/bin/realpath "$1" 2>/dev/null) || exit 1
    shift
    for link_path in "$@"; do
      link_target=$(/usr/bin/readlink "$link_path") || exit 1
      [[ "$link_target" != /* ]] || exit 1
      resolved_target=$(/bin/realpath "$link_path" 2>/dev/null) || exit 1
      case "$resolved_target" in
        "$root" | "$root"/*) ;;
        *) exit 1 ;;
      esac
    done
  ' _ "$release_root" {} +
}

private_tree() {
  local root=$1
  local mode unsafe_entry
  [[ -d "$root" && ! -L "$root" ]] || return 1
  mode=$(/usr/bin/stat -f '%Lp' "$root" 2>/dev/null) || return 1
  [[ "$mode" == 700 ]] || return 1
  unsafe_entry=$(
    /usr/bin/find "$root" \( -type l -o -perm +0077 \) -print -quit 2>/dev/null
  ) || return 1
  [[ -z "$unsafe_entry" ]]
}

loaded_gateway_matches_release() {
  local launchctl_output=$1
  local expected_plist=$2
  local expected_release=$3
  printf '%s\n' "$launchctl_output" | /usr/bin/awk \
    -v expected_plist="$expected_plist" \
    -v expected_release="$expected_release" '
      {
        line = $0
        sub(/^[[:space:]]+/, "", line)
        if (line == "path = " expected_plist) plist_matches = 1
        if (line == "JARVIS_ROOT => " expected_release) release_matches = 1
      }
      END { exit !(plist_matches && release_matches) }
    '
}

if [[ -f "$GATEWAY_PLIST" && ! -L "$GATEWAY_PLIST" && \
      -f "$WATCHDOG_PLIST" && ! -L "$WATCHDOG_PLIST" ]] && \
  /usr/bin/plutil -lint "$GATEWAY_PLIST" "$WATCHDOG_PLIST" >/dev/null 2>&1; then
  PLISTS=pass
  RELEASE_ROOT=$(
    /usr/bin/plutil -extract EnvironmentVariables.JARVIS_ROOT raw -o - "$GATEWAY_PLIST" \
      2>/dev/null || true
  )
fi

if [[ "$PLISTS" == pass ]]; then
  host=$(
    /usr/bin/plutil -extract EnvironmentVariables.HOST raw -o - "$GATEWAY_PLIST" 2>/dev/null || true
  )
  configured_port=$(
    /usr/bin/plutil -extract EnvironmentVariables.PORT raw -o - "$GATEWAY_PLIST" 2>/dev/null || true
  )
  program=$(
    /usr/bin/plutil -extract ProgramArguments.0 raw -o - "$GATEWAY_PLIST" 2>/dev/null || true
  )
  assertion=$(
    /usr/bin/plutil -extract ProgramArguments.1 raw -o - "$GATEWAY_PLIST" 2>/dev/null || true
  )
  restart_on_failure=$(
    /usr/bin/plutil -extract KeepAlive.SuccessfulExit raw -o - "$GATEWAY_PLIST" 2>/dev/null || true
  )
  umask_value=$(
    /usr/bin/plutil -extract Umask raw -o - "$GATEWAY_PLIST" 2>/dev/null || true
  )
  throttle=$(
    /usr/bin/plutil -extract ThrottleInterval raw -o - "$GATEWAY_PLIST" 2>/dev/null || true
  )
  configured_state_root=$(
    /usr/bin/plutil -extract EnvironmentVariables.JARVIS_STATE_ROOT raw -o - "$GATEWAY_PLIST" \
      2>/dev/null || true
  )
  configured_database=$(
    /usr/bin/plutil -extract EnvironmentVariables.DB_PATH raw -o - "$GATEWAY_PLIST" \
      2>/dev/null || true
  )
  configured_clients=$(
    /usr/bin/plutil -extract EnvironmentVariables.JARVIS_CLIENT_ROOT raw -o - "$GATEWAY_PLIST" \
      2>/dev/null || true
  )
  configured_workspaces=$(
    /usr/bin/plutil -extract EnvironmentVariables.JARVIS_WORKSPACE_ROOT raw -o - \
      "$GATEWAY_PLIST" 2>/dev/null || true
  )
  configured_graph=$(
    /usr/bin/plutil -extract EnvironmentVariables.JARVIS_GRAPH_ROOT raw -o - "$GATEWAY_PLIST" \
      2>/dev/null || true
  )
  configured_personal_memory=$(
    /usr/bin/plutil -extract EnvironmentVariables.JARVIS_PERSONAL_MEMORY_ROOT raw -o - \
      "$GATEWAY_PLIST" 2>/dev/null || true
  )
  configured_agency_initial_posture=$(
    /usr/bin/plutil -extract EnvironmentVariables.JARVIS_AGENCY_INITIAL_POSTURE raw -o - \
      "$GATEWAY_PLIST" 2>/dev/null || true
  )
  entrypoint=$(
    /usr/bin/plutil -extract ProgramArguments.2 raw -o - "$GATEWAY_PLIST" 2>/dev/null || true
  )
  server_file=$(
    /usr/bin/plutil -extract ProgramArguments.4 raw -o - "$GATEWAY_PLIST" 2>/dev/null || true
  )
  if [[ "$configured_state_root" == "$STATE_ROOT" && \
        "$configured_database" == "$STATE_ROOT/jarvis.sqlite" && \
        "$configured_clients" == "$STATE_ROOT/clients" && \
        "$configured_workspaces" == "$STATE_ROOT/workspaces" && \
        "$configured_graph" == "$STATE_ROOT/memory/graph" && \
        "$configured_personal_memory" == "$STATE_ROOT/memory/personal" ]]; then
    CONFIGURED_STATE_PATHS=pass
  fi
  if [[ "$host" == 127.0.0.1 && "$configured_port" == "$PORT" && \
        "$program" == /usr/bin/caffeinate && "$assertion" == -s && \
        "$entrypoint" == "$RELEASE_ROOT/scripts/runtime/runtime-entrypoint.sh" && \
        "$server_file" == "$RELEASE_ROOT/dist/src/gateway/server.js" && \
        "$configured_agency_initial_posture" =~ ^(active|paused)$ && \
        "$restart_on_failure" == false && "$umask_value" == 63 && "$throttle" == 30 && \
        "$CONFIGURED_STATE_PATHS" == pass ]] && \
    ! /usr/bin/plutil -extract Sockets raw -o - "$GATEWAY_PLIST" >/dev/null 2>&1 && \
    ! /usr/bin/plutil -extract NetworkState raw -o - "$GATEWAY_PLIST" >/dev/null 2>&1; then
    LOOPBACK_CONFIG=pass
  fi
fi

if [[ "$RELEASE_ROOT" == "$INSTALL_ROOT"/releases/* && -d "$RELEASE_ROOT" && \
      ! -L "$RELEASE_ROOT" ]] && \
  [[ -z "$(/usr/bin/find "$RELEASE_ROOT" ! -type l -perm +0222 -print -quit 2>/dev/null)" ]] && \
  contained_release_symlinks "$RELEASE_ROOT"; then
  IMMUTABLE_RELEASE=pass
fi

if [[ "$CONFIGURED_STATE_PATHS" == pass ]] && \
  private_tree "$STATE_ROOT" && private_tree "$LOG_ROOT"; then
  database_secure=true
  for database_path in \
    "$STATE_ROOT/jarvis.sqlite" \
    "$STATE_ROOT/jarvis.sqlite-wal" \
    "$STATE_ROOT/jarvis.sqlite-shm"; do
    if [[ -e "$database_path" || -L "$database_path" ]]; then
      database_mode=$(/usr/bin/stat -f '%Lp' "$database_path" 2>/dev/null || true)
      if [[ ! -f "$database_path" || -L "$database_path" || "$database_mode" != 600 ]]; then
        database_secure=false
      fi
    fi
  done
  if [[ "$database_secure" == true ]]; then
    SECURE_STATE=pass
  fi
fi

uid=$(/usr/bin/id -u)
launchctl_output=$(
  /bin/launchctl print "gui/$uid/com.aiagency.jarvis.gateway" 2>/dev/null || true
)
if [[ -n "$RELEASE_ROOT" ]] && \
  loaded_gateway_matches_release "$launchctl_output" "$GATEWAY_PLIST" "$RELEASE_ROOT"; then
  GATEWAY_LOADED=pass
fi

if [[ -n "$RELEASE_ROOT" ]] && \
  /usr/bin/pgrep -f "/usr/bin/caffeinate -s $RELEASE_ROOT/scripts/runtime/runtime-entrypoint.sh" \
    >/dev/null 2>&1; then
  CAFFEINATE_SUPERVISOR=pass
fi

listener_names=$(
  /usr/sbin/lsof -nP -a -iTCP:"$PORT" -sTCP:LISTEN -Fn 2>/dev/null |
    /usr/bin/sed -n 's/^n//p' || true
)
if [[ -n "$listener_names" ]] && \
  printf '%s\n' "$listener_names" | /usr/bin/awk -v expected="127.0.0.1:$PORT" '
    $0 == expected { exact = 1; next }
    { other = 1 }
    END { exit !(exact && !other) }
  '; then
  LOOPBACK_LISTENER=pass
fi

if /usr/bin/curl \
  --fail \
  --silent \
  --output /dev/null \
  --max-time 5 \
  --proto '=http' \
  --noproxy '*' \
  "http://127.0.0.1:$PORT/readyz" 2>/dev/null; then
  READINESS=pass
fi

if [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" && -n "$RELEASE_ROOT" && \
      -x "$RELEASE_ROOT/scripts/runtime/disk-guard.sh" ]]; then
  set +e
  "$RELEASE_ROOT/scripts/runtime/disk-guard.sh" \
    --path "$STATE_ROOT" \
    --warn-percent 20 \
    --critical-percent 10 >/dev/null
  disk_status=$?
  set -e
  case "$disk_status" in
    0) DISK_GUARD=pass ;;
    20) DISK_GUARD=warn ;;
    *) DISK_GUARD=fail ;;
  esac
fi

STATUS=GO
for required_check in \
  "$PLISTS" \
  "$LOOPBACK_CONFIG" \
  "$IMMUTABLE_RELEASE" \
  "$SECURE_STATE" \
  "$GATEWAY_LOADED" \
  "$CAFFEINATE_SUPERVISOR" \
  "$LOOPBACK_LISTENER" \
  "$READINESS"; do
  if [[ "$required_check" != pass ]]; then
    STATUS=NO_GO
  fi
done
[[ "$DISK_GUARD" != fail ]] || STATUS=NO_GO

printf '{"status":"%s","checks":{"plists":"%s","loopbackConfig":"%s","immutableRelease":"%s","secureState":"%s","gatewayLoaded":"%s","caffeinateSupervisor":"%s","loopbackListener":"%s","readiness":"%s","diskGuard":"%s"},"remoteAccess":"not_configured_by_runtime"}\n' \
  "$STATUS" \
  "$PLISTS" \
  "$LOOPBACK_CONFIG" \
  "$IMMUTABLE_RELEASE" \
  "$SECURE_STATE" \
  "$GATEWAY_LOADED" \
  "$CAFFEINATE_SUPERVISOR" \
  "$LOOPBACK_LISTENER" \
  "$READINESS" \
  "$DISK_GUARD"

[[ "$STATUS" == GO ]] || exit 10
