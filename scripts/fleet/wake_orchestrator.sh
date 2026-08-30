#!/usr/bin/env bash
# ==============================================================================
# Wake Up Task Orchestrator
#
# Forces an immediate scheduling tick in Paperclip to:
# 1. Reconcile merged GitHub PRs & archive completed tasks.
# 2. Reclaim stalled agent sessions.
# 3. Progress PR review pipeline (CI -> Vibe -> Strong Review -> Merge Approval).
# 4. Dispatch next unblocked tasks based on fine-grained DAG locks.
#
# Usage:
#   ./scripts/fleet/wake_orchestrator.sh [optional_reason]
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"
check_curl

REASON="${1:-manual_scheduling_tick}"

echo "🚀 Waking up Task Orchestrator (${ORCHESTRATOR_AGENT_ID})..."
RESPONSE=$(curl -s -X POST "${PAPERCLIP_API_URL}/api/agents/${ORCHESTRATOR_AGENT_ID}/wakeup" \
  -H "Content-Type: application/json" \
  -d "{\"reason\": \"${REASON}\"}")

if command -v jq &>/dev/null; then
  echo "${RESPONSE}" | jq '.'
else
  echo "${RESPONSE}"
fi
echo "✅ Orchestrator wakeup queued successfully."
