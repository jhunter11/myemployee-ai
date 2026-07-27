#!/usr/bin/env bash
# heartbeat.sh — Infrastructure health check (runs every 15 minutes)
# Returns structured JSON for agent consumption. Non-zero exit = escalate.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
POLICY_FILE="$REPO_ROOT/config/escalation-policy.json"
LOG_FILE="$REPO_ROOT/logs/heartbeat.jsonl"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

FAILURES=()

# 1. Check OpenClaw gateway process
if pgrep -f "openclaw.*gateway" > /dev/null 2>&1; then
  GW_STATUS="ok"
else
  GW_STATUS="down"
  FAILURES+=("gateway_down")
fi

# 2. Check Ollama (local fallback model)
if curl -s --max-time 5 http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
  OLLAMA_STATUS="ok"
else
  OLLAMA_STATUS="unreachable"
  FAILURES+=("ollama_unreachable")
fi

# 3. Check Docker daemon
if docker info > /dev/null 2>&1; then
  DOCKER_STATUS="ok"
else
  DOCKER_STATUS="down"
  FAILURES+=("docker_down")
fi

# 4. Check disk space (alert if <10% free)
DISK_FREE_PCT=$(df -h "$HOME" | tail -1 | awk '{gsub(/%/,""); print 100-$5}')
if [ "$DISK_FREE_PCT" -lt 10 ]; then
  DISK_STATUS="critical:${DISK_FREE_PCT}%_free"
  FAILURES+=("disk_low")
else
  DISK_STATUS="ok:${DISK_FREE_PCT}%_free"
fi

# 5. Determine overall health and severity
if [ ${#FAILURES[@]} -eq 0 ]; then
  OVERALL="healthy"
  SEVERITY="none"
  EXIT_CODE=0
else
  OVERALL="degraded"
  SEVERITY="P1"
  EXIT_CODE=1
fi

# Log result
cat <<EOF >> "$LOG_FILE"
{"timestamp":"$TIMESTAMP","overall":"$OVERALL","severity":"$SEVERITY","gateway":"$GW_STATUS","ollama":"$OLLAMA_STATUS","docker":"$DOCKER_STATUS","disk":"$DISK_STATUS","failures":[$(printf '"%s",' "${FAILURES[@]:-}" | sed 's/,$//')]  }
EOF

# Output for agent
cat <<EOF
{
  "timestamp": "$TIMESTAMP",
  "overall": "$OVERALL",
  "severity": "$SEVERITY",
  "checks": {
    "gateway": "$GW_STATUS",
    "ollama": "$OLLAMA_STATUS",
    "docker": "$DOCKER_STATUS",
    "disk": "$DISK_STATUS"
  },
  "failures": [$(printf '"%s",' "${FAILURES[@]:-}" | sed 's/,$//')],
  "action": $([ "$EXIT_CODE" -eq 0 ] && echo '"none"' || echo '"escalate_P1"')
}
EOF

exit $EXIT_CODE
