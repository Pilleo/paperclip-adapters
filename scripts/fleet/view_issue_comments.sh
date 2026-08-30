#!/usr/bin/env bash
# ==============================================================================
# View Comments on a Paperclip Issue
#
# Accepts either an issue identifier (e.g. MAZ-141) or a full UUID.
#
# Usage:
#   ./scripts/fleet/view_issue_comments.sh <identifier_or_id> [limit: default 5]
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"
check_curl
check_jq

TARGET="${1:-}"
LIMIT="${2:-5}"

if [ -z "${TARGET}" ]; then
  echo "Usage: $0 <issue_identifier_or_id> [limit]" >&2
  echo "Example: $0 MAZ-141 3" >&2
  exit 1
fi

# Resolve identifier to UUID if needed
ISSUE_ID="${TARGET}"
if [[ "${TARGET}" =~ ^[A-Za-z0-9_-]+-[0-9]+$ ]]; then
  echo "🔍 Resolving identifier '${TARGET}' to UUID..."
  ALL_ISSUES=$(curl -s "${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/issues?limit=500")
  RESOLVED_ID=$(echo "${ALL_ISSUES}" | jq -r --arg id "${TARGET}" '.[] | select(.identifier == $id or .id == $id) | .id' | head -n 1)
  if [ -n "${RESOLVED_ID}" ] && [ "${RESOLVED_ID}" != "null" ]; then
    ISSUE_ID="${RESOLVED_ID}"
  fi
fi

echo "💬 Fetching comments for issue '${ISSUE_ID}' (limit ${LIMIT})..."
COMMENTS=$(curl -s "${PAPERCLIP_API_URL}/api/issues/${ISSUE_ID}/comments")

echo "${COMMENTS}" | jq -r --argjson limit "${LIMIT}" '
  .[0:$limit] | .[] |
  "--------------------------------------------------------------------------------\n" +
  "[" + (.createdAt // "unknown") + "] Author: " + (.authorType // "unknown") + " (" + (.authorAgentId // "none") + ")\n" +
  "--------------------------------------------------------------------------------\n" +
  .body + "\n"
'
