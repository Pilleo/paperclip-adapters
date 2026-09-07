#!/usr/bin/env bash
# Finds compatibility/reviewer children which no longer have an active parent.
# Default is read-only. Pass --apply to mark the reported children done.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/common.sh"
check_curl
check_jq

APPLY=false
if [[ "${1:-}" == "--apply" ]]; then APPLY=true; fi
if [[ $# -gt 1 || ( $# -eq 1 && "${1}" != "--apply" ) ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 2
fi

ISSUES=$(curl -fsS --max-time 10 "${PAPERCLIP_API_URL}/api/companies/${COMPANY_ID}/issues?limit=1000")
STALE=$(echo "${ISSUES}" | jq -r '
  map({id, parentId, status, identifier, title, description}) as $all |
  $all[] |
  select(.parentId != null and (.status != "done" and .status != "cancelled")) |
  select((.description // "") | contains("jules-session-supervisor") or contains("jules-question-adjudication")) |
  . as $child | ($all | map(select(.id == $child.parentId)) | .[0]) as $parent |
  select($parent == null or $parent.status != "in_progress") |
  [$child.id, ($child.identifier // $child.id), ($child.title // "")] | @tsv')

if [[ -z "${STALE}" ]]; then
  echo "No stale Jules compatibility or adjudication children found."
  exit 0
fi

echo "Stale children:"
printf '%s\n' "${STALE}" | while IFS=$'\t' read -r id identifier title; do
  echo "- ${identifier}: ${title} (${id})"
done

if [[ "${APPLY}" != true ]]; then
  echo "Dry run only. Re-run with --apply to mark these children done."
  exit 0
fi

while IFS=$'\t' read -r id _identifier _title; do
  curl -fsS --max-time 10 -X PATCH "${PAPERCLIP_API_URL}/api/issues/${id}" \
    -H 'Content-Type: application/json' --data '{"status":"done"}' >/dev/null
  echo "Marked ${id} done."
done <<< "${STALE}"
