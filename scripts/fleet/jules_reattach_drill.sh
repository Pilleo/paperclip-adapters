#!/usr/bin/env bash
# Compare Jules runtime session ids across Paperclip restarts.
# After `paperclipai run` comes back, the latest orchestrated Jules run must
# reuse sessionIdBefore from the last successful pre-crash run (no new createSession).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"
check_curl
check_jq

echo "Jules reattach drill (orchestrated worker ${JULES_WORKER_AGENT_ID})"
echo ""

AGENT_JSON=$(curl -s "${PAPERCLIP_API_URL}/api/agents/${JULES_WORKER_AGENT_ID}")
echo "$AGENT_JSON" | jq '{name, status, errorReason}'

echo ""
echo "Recent heartbeat runs:"
curl -s "${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/heartbeat-runs?agentId=${JULES_WORKER_AGENT_ID}&limit=8" | jq -r '
  .[] | [
    (.startedAt // "null"),
    .status,
    (.invocationSource // ""),
    (.sessionIdBefore // "-"),
    (.sessionIdAfter // "-"),
    (.error // .resultJson.summary // "")
  ] | @tsv
' | column -t -s $'\t' || true

echo ""
echo "Pass: after restart, status is not stuck on process-lost, sessionIdBefore matches the last live Jules id, and resultJson is not a no-task no-op."
