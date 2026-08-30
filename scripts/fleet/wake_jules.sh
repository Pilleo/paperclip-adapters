#!/usr/bin/env bash
# ==============================================================================
# Wake Up Jules Async Worker
#
# Forces Jules worker to process pending sessions, push PR reviews directly
# to Jules Cloud Session API, or resume code generation.
#
# Usage:
#   ./scripts/fleet/wake_jules.sh [optional_reason]
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"
check_curl

REASON="${1:-process_jules_sessions}"

echo "🚀 Waking up Jules Async Worker (${JULES_WORKER_AGENT_ID})..."
RESPONSE=$(curl -s -X POST "${PAPERCLIP_API_URL}/api/agents/${JULES_WORKER_AGENT_ID}/wakeup" \
  -H "Content-Type: application/json" \
  -d "{\"reason\": \"${REASON}\"}")

if command -v jq &>/dev/null; then
  echo "${RESPONSE}" | jq '.'
else
  echo "${RESPONSE}"
fi
echo "✅ Jules worker wakeup queued successfully."
