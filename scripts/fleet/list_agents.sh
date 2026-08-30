#!/usr/bin/env bash
# ==============================================================================
# List All Company Agents and Health Status
#
# Inspects agent roles, active statuses, error/pause reasons, and org health.
#
# Usage:
#   ./scripts/fleet/list_agents.sh
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"
check_curl
check_jq

echo "🤖 Fetching agent fleet health from Paperclip (${PAPERCLIP_API_URL})..."
RAW=$(curl -s "${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/agents")

echo "${RAW}" | jq '.[] | {
  id: .id,
  name: .name,
  role: .role,
  status: .status,
  adapterType: .adapterType,
  reportsTo: .reportsTo,
  errorReason: .errorReason,
  pauseReason: .pauseReason,
  chainStatus: .orgChainHealth.status
}'
