#!/usr/bin/env bash
# ==============================================================================
# List All Company Issues on the Board
#
# Usage:
#   ./scripts/fleet/list_issues.sh [status_filter: todo|in_progress|in_review|done|all]
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"
check_curl
check_jq

FILTER="${1:-all}"

echo "📋 Fetching issues from Paperclip (${PAPERCLIP_API_URL})..."
RAW=$(curl -s "${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/issues?limit=500")

if [ "${FILTER}" != "all" ]; then
  echo "${RAW}" | jq --arg status "${FILTER}" '
    map(select(.status == $status)) |
    .[] | {
      identifier: (.identifier // .id),
      title: .title,
      status: .status,
      priority: .priority,
      assignee: .assigneeAgentId
    }'
else
  echo "${RAW}" | jq '.[] | {
    identifier: (.identifier // .id),
    title: .title,
    status: .status,
    priority: .priority,
    assignee: .assigneeAgentId
  }'
fi
