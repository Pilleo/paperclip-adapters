#!/usr/bin/env bash
# ==============================================================================
# List All Pending & Historic Board Approvals
#
# Shows task start authorizations and Stage 4 PR merge approvals.
#
# Usage:
#   ./scripts/fleet/list_approvals.sh [status: pending|approved|rejected|all]
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"
check_curl
check_jq

FILTER="${1:-all}"

echo "🏛️ Fetching approvals from Paperclip (${PAPERCLIP_API_URL})..."
RAW=$(curl -s "${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/approvals")

if [ "${FILTER}" != "all" ]; then
  echo "${RAW}" | jq --arg status "${FILTER}" '
    map(select(.status == $status)) |
    .[] | {
      id: .id,
      type: .type,
      status: .status,
      title: .title,
      description: (.description // "")[0:150]
    }'
else
  echo "${RAW}" | jq '.[] | {
    id: .id,
    type: .type,
    status: .status,
    title: .title,
    description: (.description // "")[0:150]
  }'
fi
