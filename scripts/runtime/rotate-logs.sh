#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: rotate-logs.sh --log-dir PATH [--max-bytes 10485760] [--keep 5]" >&2
  exit 64
}

LOG_DIRECTORY=""
MAX_BYTES=10485760
KEEP=5

while (($# > 0)); do
  case "$1" in
    --log-dir)
      (($# >= 2)) || usage
      LOG_DIRECTORY=$2
      shift 2
      ;;
    --max-bytes)
      (($# >= 2)) || usage
      MAX_BYTES=$2
      shift 2
      ;;
    --keep)
      (($# >= 2)) || usage
      KEEP=$2
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$LOG_DIRECTORY" == /* ]] || usage
[[ -d "$LOG_DIRECTORY" && ! -L "$LOG_DIRECTORY" ]] || {
  echo "log directory must be an existing non-symlink directory" >&2
  exit 65
}
[[ "$MAX_BYTES" =~ ^[1-9][0-9]*$ && "$KEEP" =~ ^[1-9][0-9]*$ ]] || usage
((KEEP <= 10)) || usage

file_size() {
  local path=$1
  /usr/bin/stat -f '%z' "$path" 2>/dev/null || /usr/bin/wc -c < "$path" | /usr/bin/tr -d ' '
}

for filename in gateway.stdout.log gateway.stderr.log watchdog.stdout.log watchdog.stderr.log; do
  log_path="$LOG_DIRECTORY/$filename"
  [[ -e "$log_path" ]] || continue
  [[ -f "$log_path" && ! -L "$log_path" ]] || {
    echo "refusing to rotate non-regular log: $filename" >&2
    exit 65
  }
  size=$(file_size "$log_path")
  [[ "$size" =~ ^[0-9]+$ ]] || exit 65
  ((size > MAX_BYTES)) || continue

  /bin/rm -f "$log_path.$KEEP"
  generation=$((KEEP - 1))
  while ((generation >= 1)); do
    if [[ -f "$log_path.$generation" && ! -L "$log_path.$generation" ]]; then
      /bin/mv "$log_path.$generation" "$log_path.$((generation + 1))"
    fi
    generation=$((generation - 1))
  done
  /bin/cp -p "$log_path" "$log_path.1"
  : > "$log_path"
  /bin/chmod 0600 "$log_path" "$log_path.1"
done
