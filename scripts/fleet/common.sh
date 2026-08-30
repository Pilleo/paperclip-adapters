#!/usr/bin/env bash
# ==============================================================================
# Paperclip Fleet Operations - Shared Configuration & Helpers
# ==============================================================================
set -euo pipefail

export PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
export COMPANY_ID="${COMPANY_ID:-8f4ef932-d769-43b2-981a-d273ed715162}" # mazewall

# Known Core Agent IDs
export ORCHESTRATOR_AGENT_ID="f9bf7329-0649-4c0d-bfe0-680cfd9e8c9a"
export JULES_WORKER_AGENT_ID="6e722f1f-ae06-425a-938d-e3c734bf7344"
export REVIEWER_AGENT_ID="a073e084-d141-43cf-a2ae-39cf97cfb94a"
export VIBE_WORKER_AGENT_ID="eeca53a4-c8b6-40a0-be3f-c7e56d732ce2"
export ANTIGRAVITY_AGENT_ID="80985a1f-d3e6-4b97-afcb-48c46e4a2073"

check_curl() {
  if ! command -v curl &>/dev/null; then
    echo "❌ Error: 'curl' is required but not installed." >&2
    exit 1
  fi
}

check_jq() {
  if ! command -v jq &>/dev/null; then
    echo "❌ Error: 'jq' is required but not installed." >&2
    exit 1
  fi
}
