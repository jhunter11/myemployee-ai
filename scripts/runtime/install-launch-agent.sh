#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIRECTORY=$(cd "$(/usr/bin/dirname "$0")" && pwd -P)
DEFAULT_SOURCE_ROOT=$(cd "$SCRIPT_DIRECTORY/../.." && pwd -P)
MODE=dry-run
SOURCE_ROOT=$DEFAULT_SOURCE_ROOT
INSTALL_ROOT="${HOME}/Library/Application Support/Jarvis"
LAUNCH_AGENTS_DIRECTORY="${HOME}/Library/LaunchAgents"
NODE_BIN=$(command -v node || true)
RELEASE_ID=""
PORT=3000
TELEGRAM_USER_ID=""
TELEGRAM_CHAT_ID=""
TELEGRAM_KEYCHAIN_SERVICE=com.aiagency.jarvis.telegram
TELEGRAM_KEYCHAIN_ACCOUNT=bot-token
INITIAL_AGENCY_POSTURE=paused
DATABASE_INPUTS=(
  memory/core/schema.sql
  memory/clients/_template/schema.sql
  src/db/migrations/001_agent_runs.sql
  src/db/migrations/002_run_recovery_queue.sql
  src/db/migrations/003_model_usage_events.sql
  src/db/migrations/004_knowledge_scopes.sql
  src/db/migrations/005_priority_queue.sql
  src/db/migrations/006_revenue_pipeline.sql
  src/db/migrations/007_agent_conversations.sql
  src/db/migrations/008_agent_conversation_integrity.sql
  src/db/migrations/009_agent_blueprints.sql
  src/db/migrations/010_access_control_sleeves.sql
  src/db/migrations/011_scoped_lexical_retrieval.sql
  src/db/migrations/012_telegram_channel.sql
  src/db/migrations/013_command_proposals.sql
  src/db/migrations/014_calendar_connections.sql
  src/db/migrations/015_delegation_traces.sql
  src/db/migrations/016_profile_access_lifecycle_audit.sql
  src/db/migrations/017_agency_execution_posture.sql
  src/db/migrations/018_verification_freeze.sql
  src/db/migrations/019_primary_schema_version.sql
  src/db/migrations/020_model_execution_enablement.sql
  src/db/migrations/021_provider_rate_limit_circuits.sql
  src/db/migrations/022_agent_conversation_turn_claims.sql
  src/db/migrations/023_typed_hybrid_memory.sql
  src/db/migrations/024_memory_ledger.sql
  src/db/migrations/025_memory_experiment_log.sql
  src/db/migrations/026_agent_profile_instances.sql
  src/db/migrations/027_memory_maintenance_outbox.sql
)
ONBOARDING_INPUTS=(memory/clients/_template/client_sops.md)
COPIED_DIRECTORIES=(dist public config clients skills node_modules scripts/runtime)

usage() {
  cat >&2 <<'EOF'
usage: install-launch-agent.sh [--dry-run|--install] [options]

Options:
  --source-root PATH        built repository root
  --install-root PATH       immutable releases and mutable state root
  --launch-agents-dir PATH  destination for unloaded user LaunchAgents
  --node-bin PATH           absolute Node.js executable
  --release-id ID           immutable release identifier
  --port PORT               loopback gateway port (default: 3000)
  --initial-agency-posture POSTURE
                            first-start posture: paused (default) or active
  --telegram-user-id ID     exact positive Telegram user ID (requires chat ID)
  --telegram-chat-id ID     exact positive private-chat ID (requires user ID)
  --telegram-keychain-service NAME
                            Keychain service containing the bot token
  --telegram-keychain-account NAME
                            Keychain account containing the bot token

--install writes files but deliberately does not call launchctl.
EOF
  exit 64
}

while (($# > 0)); do
  case "$1" in
    --dry-run)
      MODE=dry-run
      shift
      ;;
    --install)
      MODE=install
      shift
      ;;
    --source-root)
      (($# >= 2)) || usage
      SOURCE_ROOT=$2
      shift 2
      ;;
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
    --node-bin)
      (($# >= 2)) || usage
      NODE_BIN=$2
      shift 2
      ;;
    --release-id)
      (($# >= 2)) || usage
      RELEASE_ID=$2
      shift 2
      ;;
    --port)
      (($# >= 2)) || usage
      PORT=$2
      shift 2
      ;;
    --initial-agency-posture)
      (($# >= 2)) || usage
      INITIAL_AGENCY_POSTURE=$2
      shift 2
      ;;
    --telegram-user-id)
      (($# >= 2)) || usage
      TELEGRAM_USER_ID=$2
      shift 2
      ;;
    --telegram-chat-id)
      (($# >= 2)) || usage
      TELEGRAM_CHAT_ID=$2
      shift 2
      ;;
    --telegram-keychain-service)
      (($# >= 2)) || usage
      TELEGRAM_KEYCHAIN_SERVICE=$2
      shift 2
      ;;
    --telegram-keychain-account)
      (($# >= 2)) || usage
      TELEGRAM_KEYCHAIN_ACCOUNT=$2
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$SOURCE_ROOT" == /* && -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] || {
  echo "source root must be an absolute non-symlink directory" >&2
  exit 65
}
SOURCE_ROOT=$(cd "$SOURCE_ROOT" && pwd -P)
[[ "$INSTALL_ROOT" == /* && "$LAUNCH_AGENTS_DIRECTORY" == /* ]] || usage
[[ "$NODE_BIN" == /* && -x "$NODE_BIN" && ! -L "$NODE_BIN" ]] || {
  echo "node-bin must be an absolute direct executable" >&2
  exit 65
}
[[ "$PORT" =~ ^[0-9]+$ ]] || usage
((PORT >= 1 && PORT <= 65535)) || usage
[[ "$INITIAL_AGENCY_POSTURE" == paused || "$INITIAL_AGENCY_POSTURE" == active ]] || usage
[[ -z "$TELEGRAM_USER_ID" && -z "$TELEGRAM_CHAT_ID" ]] || {
  [[ "$TELEGRAM_USER_ID" =~ ^[1-9][0-9]{0,15}$ ]] || usage
  [[ "$TELEGRAM_CHAT_ID" =~ ^[1-9][0-9]{0,15}$ ]] || usage
}
[[ "$TELEGRAM_KEYCHAIN_SERVICE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$ ]] || usage
[[ "$TELEGRAM_KEYCHAIN_ACCOUNT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$ ]] || usage
TELEGRAM_CONFIGURED=false
if [[ -n "$TELEGRAM_USER_ID" ]]; then
  TELEGRAM_CONFIGURED=true
fi

assert_contained_symlinks() {
  local tree_root=$1
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const requestedRoot = process.argv[1];
    const metadata = fs.lstatSync(requestedRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) process.exit(1);
    const root = fs.realpathSync(requestedRoot);
    const pending = [root];
    let entryCount = 0;
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        entryCount += 1;
        if (entryCount > 1_000_000) process.exit(1);
        const entryPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          const targetText = fs.readlinkSync(entryPath);
          if (path.isAbsolute(targetText)) process.exit(1);
          const target = fs.realpathSync(entryPath);
          const relativeTarget = path.relative(root, target);
          if (
            relativeTarget !== "" &&
            (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget))
          ) process.exit(1);
          continue;
        }
        if (entry.isDirectory()) pending.push(entryPath);
        else if (!entry.isFile()) process.exit(1);
      }
    }
  ' "$tree_root"
}

if [[ -z "$RELEASE_ID" ]]; then
  RELEASE_ID=$(/usr/bin/git -C "$SOURCE_ROOT" rev-parse --verify HEAD 2>/dev/null || true)
fi
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || {
  echo "release-id must be explicit or resolve to a safe Git commit" >&2
  exit 65
}

for required_path in \
  dist/src/gateway/server.js \
  public/dashboard \
  config \
  clients \
  skills \
  node_modules \
  memory/clients/_template/client_sops.md \
  package.json \
  package-lock.json \
  scripts/runtime/runtime-entrypoint.sh \
  scripts/runtime/runtime-watchdog.sh \
  scripts/runtime/disk-guard.sh \
  scripts/runtime/rotate-logs.sh; do
  [[ -e "$SOURCE_ROOT/$required_path" ]] || {
    echo "built runtime input is missing: $required_path" >&2
    exit 66
  }
done

for copied_directory in "${COPIED_DIRECTORIES[@]}"; do
  [[ -d "$SOURCE_ROOT/$copied_directory" && ! -L "$SOURCE_ROOT/$copied_directory" ]] || {
    echo "built runtime directory is missing or indirect: $copied_directory" >&2
    exit 66
  }
  assert_contained_symlinks "$SOURCE_ROOT/$copied_directory" || {
    echo "release input contains an unsafe symlink: $copied_directory" >&2
    exit 66
  }
done

for direct_file in \
  dist/src/gateway/server.js \
  package.json \
  package-lock.json \
  "${ONBOARDING_INPUTS[@]}"; do
  [[ -f "$SOURCE_ROOT/$direct_file" && ! -L "$SOURCE_ROOT/$direct_file" ]] || {
    echo "built runtime input is missing or not a direct file: $direct_file" >&2
    exit 66
  }
done

for database_input in "${DATABASE_INPUTS[@]}"; do
  [[ -f "$SOURCE_ROOT/$database_input" && ! -L "$SOURCE_ROOT/$database_input" ]] || {
    echo "built runtime input is missing or not a direct file: $database_input" >&2
    exit 66
  }
done

RELEASES_ROOT="$INSTALL_ROOT/releases"
RELEASE_ROOT="$RELEASES_ROOT/$RELEASE_ID"
STATE_ROOT="$INSTALL_ROOT/state"
LOG_ROOT="$INSTALL_ROOT/logs"
GATEWAY_PLIST="$LAUNCH_AGENTS_DIRECTORY/com.aiagency.jarvis.gateway.plist"
WATCHDOG_PLIST="$LAUNCH_AGENTS_DIRECTORY/com.aiagency.jarvis.watchdog.plist"

emit_result() {
  "$NODE_BIN" -e '
    const [mode, releaseId, releaseRoot, stateRoot, logRoot, gatewayPlist, watchdogPlist, port, telegramConfigured, initialAgencyPosture] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      mode,
      releaseId,
      releaseRoot,
      stateRoot,
      logRoot,
      gatewayPlist,
      watchdogPlist,
      loaded: false,
      host: "127.0.0.1",
      port: Number(port),
      telegramConfigured: telegramConfigured === "true",
      initialAgencyPosture
    }) + "\n");
  ' "$MODE" "$RELEASE_ID" "$RELEASE_ROOT" "$STATE_ROOT" "$LOG_ROOT" \
    "$GATEWAY_PLIST" "$WATCHDOG_PLIST" "$PORT" "$TELEGRAM_CONFIGURED" \
    "$INITIAL_AGENCY_POSTURE"
}

if [[ "$MODE" == dry-run ]]; then
  emit_result
  exit 0
fi

[[ ! -e "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]] || {
  echo "immutable release already exists" >&2
  exit 73
}
[[ ! -e "$GATEWAY_PLIST" && ! -L "$GATEWAY_PLIST" ]] || {
  echo "gateway LaunchAgent already exists; refusing implicit replacement" >&2
  exit 73
}
[[ ! -e "$WATCHDOG_PLIST" && ! -L "$WATCHDOG_PLIST" ]] || {
  echo "watchdog LaunchAgent already exists; refusing implicit replacement" >&2
  exit 73
}
for existing_root in "$INSTALL_ROOT" "$LAUNCH_AGENTS_DIRECTORY"; do
  if [[ -e "$existing_root" ]]; then
    [[ -d "$existing_root" && ! -L "$existing_root" ]] || {
      echo "install destination is not a direct directory" >&2
      exit 65
    }
  fi
done

/usr/bin/install -d -m 0700 "$INSTALL_ROOT" "$RELEASES_ROOT" "$STATE_ROOT" "$LOG_ROOT"
if [[ ! -d "$LAUNCH_AGENTS_DIRECTORY" ]]; then
  /usr/bin/install -d -m 0700 "$LAUNCH_AGENTS_DIRECTORY"
fi
/usr/bin/install -d -m 0700 \
  "$STATE_ROOT/clients" \
  "$STATE_ROOT/workspaces" \
  "$STATE_ROOT/memory/graph" \
  "$STATE_ROOT/memory/personal"

STAGING_ROOT=$(/usr/bin/mktemp -d "$RELEASES_ROOT/.stage.XXXXXX")
cleanup_staging() {
  if [[ -n "${STAGING_ROOT:-}" && -d "$STAGING_ROOT" ]]; then
    /bin/rm -rf "$STAGING_ROOT"
  fi
}
trap cleanup_staging EXIT

for directory in "${COPIED_DIRECTORIES[@]}"; do
  /usr/bin/ditto "$SOURCE_ROOT/$directory" "$STAGING_ROOT/$directory"
done
/usr/bin/ditto "$SOURCE_ROOT/package.json" "$STAGING_ROOT/package.json"
/usr/bin/ditto "$SOURCE_ROOT/package-lock.json" "$STAGING_ROOT/package-lock.json"
for onboarding_input in "${ONBOARDING_INPUTS[@]}"; do
  onboarding_destination="$STAGING_ROOT/$onboarding_input"
  /usr/bin/install -d -m 0700 "$(/usr/bin/dirname "$onboarding_destination")"
  /usr/bin/ditto "$SOURCE_ROOT/$onboarding_input" "$onboarding_destination"
done
for database_input in "${DATABASE_INPUTS[@]}"; do
  database_destination="$STAGING_ROOT/$database_input"
  /usr/bin/install -d -m 0700 "$(/usr/bin/dirname "$database_destination")"
  /usr/bin/ditto "$SOURCE_ROOT/$database_input" "$database_destination"
done

for copied_directory in "${COPIED_DIRECTORIES[@]}"; do
  assert_contained_symlinks "$STAGING_ROOT/$copied_directory" || {
    echo "staged release contains an unsafe symlink: $copied_directory" >&2
    exit 66
  }
done

/usr/bin/find "$STAGING_ROOT" -type d -exec /bin/chmod 0555 {} +
/usr/bin/find "$STAGING_ROOT" -type f -exec /bin/chmod 0444 {} +
/bin/chmod 0555 "$STAGING_ROOT/scripts/runtime/"*.sh
/bin/mv "$STAGING_ROOT" "$RELEASE_ROOT"
STAGING_ROOT=""

create_gateway_plist() {
  local path=$1
  /usr/bin/plutil -create xml1 "$path"
  /usr/bin/plutil -insert Label -string com.aiagency.jarvis.gateway "$path"
  /usr/bin/plutil -insert ProgramArguments -array "$path"
  /usr/bin/plutil -insert ProgramArguments.0 -string /usr/bin/caffeinate "$path"
  /usr/bin/plutil -insert ProgramArguments.1 -string -s "$path"
  /usr/bin/plutil -insert ProgramArguments.2 -string \
    "$RELEASE_ROOT/scripts/runtime/runtime-entrypoint.sh" "$path"
  /usr/bin/plutil -insert ProgramArguments.3 -string "$NODE_BIN" "$path"
  /usr/bin/plutil -insert ProgramArguments.4 -string \
    "$RELEASE_ROOT/dist/src/gateway/server.js" "$path"
  /usr/bin/plutil -insert KeepAlive -dictionary "$path"
  /usr/bin/plutil -insert KeepAlive.SuccessfulExit -bool false "$path"
  /usr/bin/plutil -insert ThrottleInterval -integer 30 "$path"
  /usr/bin/plutil -insert ProcessType -string Background "$path"
  /usr/bin/plutil -insert Umask -integer 63 "$path"
  /usr/bin/plutil -insert ExitTimeOut -integer 30 "$path"
  /usr/bin/plutil -insert EnvironmentVariables -dictionary "$path"
  /usr/bin/plutil -insert EnvironmentVariables.HOST -string 127.0.0.1 "$path"
  /usr/bin/plutil -insert EnvironmentVariables.PORT -string "$PORT" "$path"
  /usr/bin/plutil -insert EnvironmentVariables.JARVIS_ROOT -string "$RELEASE_ROOT" "$path"
  /usr/bin/plutil -insert EnvironmentVariables.JARVIS_STATE_ROOT -string "$STATE_ROOT" "$path"
  /usr/bin/plutil -insert EnvironmentVariables.DB_PATH -string "$STATE_ROOT/jarvis.sqlite" "$path"
  /usr/bin/plutil -insert EnvironmentVariables.JARVIS_CLIENT_ROOT -string \
    "$STATE_ROOT/clients" "$path"
  /usr/bin/plutil -insert EnvironmentVariables.JARVIS_WORKSPACE_ROOT -string \
    "$STATE_ROOT/workspaces" "$path"
  /usr/bin/plutil -insert EnvironmentVariables.JARVIS_GRAPH_ROOT -string \
    "$STATE_ROOT/memory/graph" "$path"
  /usr/bin/plutil -insert EnvironmentVariables.JARVIS_PERSONAL_MEMORY_ROOT -string \
    "$STATE_ROOT/memory/personal" "$path"
  /usr/bin/plutil -insert EnvironmentVariables.JARVIS_AGENCY_INITIAL_POSTURE -string \
    "$INITIAL_AGENCY_POSTURE" "$path"
  if [[ "$TELEGRAM_CONFIGURED" == true ]]; then
    /usr/bin/plutil -insert EnvironmentVariables.JARVIS_TELEGRAM_ENABLED -string 1 "$path"
    /usr/bin/plutil -insert EnvironmentVariables.JARVIS_TELEGRAM_USER_ID -string \
      "$TELEGRAM_USER_ID" "$path"
    /usr/bin/plutil -insert EnvironmentVariables.JARVIS_TELEGRAM_CHAT_ID -string \
      "$TELEGRAM_CHAT_ID" "$path"
    /usr/bin/plutil -insert EnvironmentVariables.JARVIS_TELEGRAM_KEYCHAIN_SERVICE -string \
      "$TELEGRAM_KEYCHAIN_SERVICE" "$path"
    /usr/bin/plutil -insert EnvironmentVariables.JARVIS_TELEGRAM_KEYCHAIN_ACCOUNT -string \
      "$TELEGRAM_KEYCHAIN_ACCOUNT" "$path"
  fi
  /usr/bin/plutil -insert StandardOutPath -string "$LOG_ROOT/gateway.stdout.log" "$path"
  /usr/bin/plutil -insert StandardErrorPath -string "$LOG_ROOT/gateway.stderr.log" "$path"
}

create_watchdog_plist() {
  local path=$1
  /usr/bin/plutil -create xml1 "$path"
  /usr/bin/plutil -insert Label -string com.aiagency.jarvis.watchdog "$path"
  /usr/bin/plutil -insert ProgramArguments -array "$path"
  /usr/bin/plutil -insert ProgramArguments.0 -string \
    "$RELEASE_ROOT/scripts/runtime/runtime-watchdog.sh" "$path"
  /usr/bin/plutil -insert StartInterval -integer 60 "$path"
  /usr/bin/plutil -insert RunAtLoad -bool true "$path"
  /usr/bin/plutil -insert ProcessType -string Background "$path"
  /usr/bin/plutil -insert Umask -integer 63 "$path"
  /usr/bin/plutil -insert EnvironmentVariables -dictionary "$path"
  /usr/bin/plutil -insert EnvironmentVariables.JARVIS_HEALTH_BASE_URL -string \
    "http://127.0.0.1:$PORT" "$path"
  /usr/bin/plutil -insert EnvironmentVariables.JARVIS_STATE_ROOT -string "$STATE_ROOT" "$path"
  /usr/bin/plutil -insert EnvironmentVariables.JARVIS_LOG_ROOT -string "$LOG_ROOT" "$path"
  /usr/bin/plutil -insert StandardOutPath -string "$LOG_ROOT/watchdog.stdout.log" "$path"
  /usr/bin/plutil -insert StandardErrorPath -string "$LOG_ROOT/watchdog.stderr.log" "$path"
}

GATEWAY_TEMP=$(/usr/bin/mktemp "$LAUNCH_AGENTS_DIRECTORY/.jarvis-gateway.XXXXXX")
WATCHDOG_TEMP=$(/usr/bin/mktemp "$LAUNCH_AGENTS_DIRECTORY/.jarvis-watchdog.XXXXXX")
trap '/bin/rm -f "$GATEWAY_TEMP" "$WATCHDOG_TEMP"; cleanup_staging' EXIT
create_gateway_plist "$GATEWAY_TEMP"
create_watchdog_plist "$WATCHDOG_TEMP"
/usr/bin/plutil -lint "$GATEWAY_TEMP" "$WATCHDOG_TEMP" >/dev/null
/bin/chmod 0600 "$GATEWAY_TEMP" "$WATCHDOG_TEMP"
/bin/mv "$GATEWAY_TEMP" "$GATEWAY_PLIST"
/bin/mv "$WATCHDOG_TEMP" "$WATCHDOG_PLIST"
trap cleanup_staging EXIT

emit_result
