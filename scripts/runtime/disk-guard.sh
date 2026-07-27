#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: disk-guard.sh --path PATH [--warn-percent 20] [--critical-percent 10]" >&2
  exit 64
}

TARGET_PATH=""
WARN_PERCENT=20
CRITICAL_PERCENT=10

while (($# > 0)); do
  case "$1" in
    --path)
      (($# >= 2)) || usage
      TARGET_PATH=$2
      shift 2
      ;;
    --warn-percent)
      (($# >= 2)) || usage
      WARN_PERCENT=$2
      shift 2
      ;;
    --critical-percent)
      (($# >= 2)) || usage
      CRITICAL_PERCENT=$2
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$TARGET_PATH" == /* ]] || usage
[[ -d "$TARGET_PATH" && ! -L "$TARGET_PATH" ]] || {
  printf '{"status":"unavailable","action":"hold_new_work","reason":"disk_probe_unavailable"}\n'
  exit 11
}
[[ "$WARN_PERCENT" =~ ^[0-9]+$ && "$CRITICAL_PERCENT" =~ ^[0-9]+$ ]] || usage
((WARN_PERCENT >= 1 && WARN_PERCENT <= 100)) || usage
((CRITICAL_PERCENT >= 0 && CRITICAL_PERCENT < WARN_PERCENT)) || usage

FREE_PERCENT=$(/bin/df -Pk "$TARGET_PATH" | /usr/bin/awk 'NR == 2 && $2 > 0 { print int(($4 * 100) / $2) }')
[[ "$FREE_PERCENT" =~ ^[0-9]+$ ]] || {
  printf '{"status":"unavailable","action":"hold_new_work","reason":"disk_probe_unavailable"}\n'
  exit 11
}

if ((FREE_PERCENT < CRITICAL_PERCENT)); then
  printf '{"status":"critical","action":"hold_new_work","freePercent":%d,"criticalBelow":%d,"warnBelow":%d}\n' \
    "$FREE_PERCENT" "$CRITICAL_PERCENT" "$WARN_PERCENT"
  exit 10
fi

if ((FREE_PERCENT < WARN_PERCENT)); then
  printf '{"status":"warning","action":"drain_and_cleanup","freePercent":%d,"criticalBelow":%d,"warnBelow":%d}\n' \
    "$FREE_PERCENT" "$CRITICAL_PERCENT" "$WARN_PERCENT"
  exit 20
fi

printf '{"status":"healthy","action":"none","freePercent":%d,"criticalBelow":%d,"warnBelow":%d}\n' \
  "$FREE_PERCENT" "$CRITICAL_PERCENT" "$WARN_PERCENT"
