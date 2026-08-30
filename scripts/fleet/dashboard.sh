#!/usr/bin/env bash
# ==============================================================================
# Paperclip Fleet Single-Pane CLI Status Dashboard
#
# Usage:
#   ./scripts/fleet/dashboard.sh
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"
check_curl
check_jq

echo "🎛️ =============================================================================="
echo "🎛️  Paperclip Multi-Agent Fleet Terminal Dashboard"
echo "🎛️ =============================================================================="
echo ""

# 1. Fetch Issues
ISSUES_JSON=$(curl -s "${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/issues?limit=500" 2>/dev/null || echo "[]")
TODO_COUNT=$(echo "${ISSUES_JSON}" | jq '[.[] | select(.status == "todo")] | length')
RUNNING_COUNT=$(echo "${ISSUES_JSON}" | jq '[.[] | select(.status == "in_progress")] | length')
REVIEW_COUNT=$(echo "${ISSUES_JSON}" | jq '[.[] | select(.status == "in_review")] | length')
DONE_COUNT=$(echo "${ISSUES_JSON}" | jq '[.[] | select(.status == "done")] | length')
TOTAL_COUNT=$(echo "${ISSUES_JSON}" | jq 'length')

echo "📊 BOARD STATUS OVERVIEW"
echo "   Total Tasks: ${TOTAL_COUNT} | 📝 Todo: ${TODO_COUNT} | ⚡ In Progress: ${RUNNING_COUNT} | 🔍 In Review: ${REVIEW_COUNT} | ✅ Done: ${DONE_COUNT}"
echo ""

# 2. In Progress & In Review Tasks
if [ "${RUNNING_COUNT}" -gt 0 ] || [ "${REVIEW_COUNT}" -gt 0 ]; then
  echo "⚡ ACTIVE & IN-REVIEW TASKS:"
  echo "${ISSUES_JSON}" | jq -r '
    .[] | select(.status == "in_progress" or .status == "in_review") |
    "   - [" + (.identifier // .id) + "] " + .title + " (" + .status + ", Priority: " + .priority + ")"
  '
  echo ""
fi

# 3. Fetch Approvals
APPROVALS_JSON=$(curl -s "${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/approvals" 2>/dev/null || echo "[]")
PENDING_APPS=$(echo "${APPROVALS_JSON}" | jq '[.[] | select(.status == "pending")] | length')

echo "🏛️ OPERATOR APPROVALS GATE: ${PENDING_APPS} pending"
if [ "${PENDING_APPS}" -gt 0 ]; then
  echo "${APPROVALS_JSON}" | jq -r '
    .[] | select(.status == "pending") |
    "   - [PENDING] " + .title + " (" + .type + ")"
  '
fi
echo ""

# 4. Fetch Agents & Incidents
AGENTS_JSON=$(curl -s "${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/agents" 2>/dev/null || echo "[]")
echo "🤖 MANAGED FLEET AGENTS:"
echo "${AGENTS_JSON}" | jq -r '
  .[] | select(.name | contains("[Orchestrated]") or contains("Task Orchestrator")) |
  "   - " + .name + ": " + .status + (if .errorReason then " ❌ " + .errorReason else "" end)
'
echo ""

echo "=============================================================================="
echo "💡 Quick Actions: [pnpm fleet:tick] [pnpm fleet:issues] [pnpm fleet:approvals]"
