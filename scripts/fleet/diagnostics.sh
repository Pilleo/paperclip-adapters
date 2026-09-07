#!/usr/bin/env bash
# Read-only operational summary for the local Paperclip + adapter service.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"
check_curl
check_jq

echo "Paperclip adapter diagnostics"
curl -fsS --max-time 5 "${PAPERCLIP_API_URL}/api/health" | jq '{status, version, deploymentMode, authReady}'

ISSUES=$(curl -fsS --max-time 10 "${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/issues?limit=1000")
echo ""
echo "Marked child state:"
echo "${ISSUES}" | jq '[.[] | select((.description // "") | contains("jules-session-supervisor") or contains("jules-question-adjudication")) | {identifier: (.identifier // .id), parentId, status, assigneeAgentId, title}]'

echo ""
echo "Latest Jules heartbeat runs:"
curl -fsS --max-time 10 "${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/heartbeat-runs?agentId=${JULES_WORKER_AGENT_ID}&limit=8" \
  | jq '[.[] | {status, issueId, startedAt, finishedAt, retryNotBefore, errorCode}]'

echo ""
echo "Ready Jules PR convergence (dry run):"
node "${DIR}/reconcile_jules_prs.mjs" --dry-run --json || true

if command -v journalctl >/dev/null 2>&1; then
  echo ""
  echo "Latest adapter capability incidents:"
  journalctl --user -u paperclipai.service --no-pager -n 1000 2>/dev/null \
    | rg 'Capability circuit opened|Skipped managed-worker wakeup' \
    | tail -n 20 || true
fi
