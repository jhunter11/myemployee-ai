#!/usr/bin/env bash
# scaffold-client.sh
# AXI (Agent Ergonomics) optimized script to provision a new client sandbox.
# Emits dense, parseable JSON for the orchestrating agent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

if [ "$#" -ne 1 ]; then
    echo '{"error": "Usage: ./scaffold-client.sh <client_id>"}' >&2
    exit 1
fi

CLIENT_ID=$1
CLIENT_DIR="$REPO_ROOT/clients/$CLIENT_ID"
WORKSPACE_DIR="$HOME/.openclaw/workspaces/$CLIENT_ID"

# Idempotent creation
mkdir -p "$CLIENT_DIR"
mkdir -p "$WORKSPACE_DIR"

# Clone memory template
if [ -d "$REPO_ROOT/memory/clients/_template" ]; then
    mkdir -p "$CLIENT_DIR/memory"
    cp -r "$REPO_ROOT/memory/clients/_template/"* "$CLIENT_DIR/memory/"
fi

# Generate isolated hierarchical stub config for OpenClaw injection
cat <<EOF > "$CLIENT_DIR/agent-config-stub.json"
[
  {
    "id": "${CLIENT_ID}_supervisor",
    "name": "Supervisor - $CLIENT_ID",
    "workspace": "$WORKSPACE_DIR",
    "sandbox": {
      "mode": "all",
      "scope": "agent",
      "workspaceAccess": "rw",
      "binds": [
        "$HOME/ai-agency-jarvis/skills:$WORKSPACE_DIR/skills:ro"
      ]
    },
    "tools": {
      "allow": ["read", "write", "exec", "process"]
    }
  },
  {
    "id": "${CLIENT_ID}_worker",
    "name": "Generic Worker - $CLIENT_ID",
    "workspace": "$WORKSPACE_DIR",
    "sandbox": {
      "mode": "all",
      "scope": "agent",
      "workspaceAccess": "rw"
    },
    "tools": {
      "allow": ["read", "write"]
    }
  }
]
EOF

# Output status payload for agent parser
cat <<EOF
{
  "status": "success",
  "client_id": "$CLIENT_ID",
  "client_dir": "$CLIENT_DIR",
  "workspace": "$WORKSPACE_DIR",
  "stub_config": "$CLIENT_DIR/agent-config-stub.json",
  "next_action": "Inject stub_config into openclaw.json agents.list"
}
EOF
