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
#   ./scripts/fleet/wake_orchestrator.sh <project_id>
#
# On-demand orchestrator runs must carry the typed project-scope envelope.
# An arbitrary reason creates an unscoped run that the adapter deliberately
# rejects before touching company state.
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"
check_curl

PROJECT_ID="${1:-${PROJECT_ID:-}}"
if [[ -z "${PROJECT_ID}" ]]; then
  echo "❌ Error: project ID is required for an authoritative orchestrator wake." >&2
  exit 2
fi
if [[ ! "${PROJECT_ID}" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "❌ Error: project ID contains unsupported characters." >&2
  exit 2
fi
REASON="paperclip-orchestrator-scope/v1/project/${PROJECT_ID}"

echo "🚀 Waking up Task Orchestrator (${ORCHESTRATOR_AGENT_ID})..."
RESPONSE=$(curl -s -X POST "${PAPERCLIP_API_URL}/api/agents/${ORCHESTRATOR_AGENT_ID}/wakeup" \
  -H "Content-Type: application/json" \
  -d "{\"source\":\"on_demand\",\"reason\":\"${REASON}\",\"payload\":{\"projectId\":\"${PROJECT_ID}\"}}")

if command -v jq &>/dev/null; then
  echo "${RESPONSE}" | jq '.'
else
  echo "${RESPONSE}"
fi
echo "✅ Orchestrator wakeup queued successfully."
