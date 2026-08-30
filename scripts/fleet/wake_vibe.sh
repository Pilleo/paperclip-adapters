#!/usr/bin/env bash
# ==============================================================================
# Wake Up Vibe Local Worker
#
# Wakes up Vibe ACP worker to run task interviews, autonomous clarifications,
# or Stage 2 fast PR code reviews.
#
# Usage:
#   ./scripts/fleet/wake_vibe.sh [optional_reason]
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"
check_curl

REASON="${1:-vibe_task_dispatch}"

echo "🚀 Waking up Vibe Local Worker (${VIBE_WORKER_AGENT_ID})..."
RESPONSE=$(curl -s -X POST "${PAPERCLIP_API_URL}/api/agents/${VIBE_WORKER_AGENT_ID}/wakeup" \
  -H "Content-Type: application/json" \
  -d "{\"reason\": \"${REASON}\"}")

if command -v jq &>/dev/null; then
  echo "${RESPONSE}" | jq '.'
else
  echo "${RESPONSE}"
fi
echo "✅ Vibe worker wakeup queued successfully."
