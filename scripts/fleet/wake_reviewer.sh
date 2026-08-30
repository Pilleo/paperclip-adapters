#!/usr/bin/env bash
# ==============================================================================
# Wake Up Code Reviewer Agent
#
# Forces Code Reviewer to evaluate in-review PRs against project invariants,
# Landlock/seccomp boundaries, FFM layouts, and test health.
#
# Usage:
#   ./scripts/fleet/wake_reviewer.sh [optional_reason]
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"
check_curl

REASON="${1:-code_review_requested}"

echo "🚀 Waking up Code Reviewer (${REVIEWER_AGENT_ID})..."
RESPONSE=$(curl -s -X POST "${PAPERCLIP_API_URL}/api/agents/${REVIEWER_AGENT_ID}/wakeup" \
  -H "Content-Type: application/json" \
  -d "{\"reason\": \"${REASON}\"}")

if command -v jq &>/dev/null; then
  echo "${RESPONSE}" | jq '.'
else
  echo "${RESPONSE}"
fi
echo "✅ Code Reviewer wakeup queued successfully."
