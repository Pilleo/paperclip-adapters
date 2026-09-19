---
title: "Show actionable metadata in fleet approval listings"
severity: "MEDIUM"
status: "resolved"
orchestrator_managed: true
priority: critical
dependencies: []
component: "tools"
target_modules:
  - "packages/orchestrator"
target_files:
  - "scripts/fleet/list_approvals.sh"
target_symbols:
  - "list_approvals"
open_questions: false
has_side_effects: false

paperclip_issue_id: "ecb81b04-8942-4a4d-9afd-2618fd81ffdf"
paperclip_identifier: "MAZ-1241"
---

# 🟡 [Severity: MEDIUM]: Show actionable metadata in fleet approval listings

**Context:**
The fleet approval script currently prints null title and an empty description for native task-start approvals even though payload.action, payload.identifier, and payload.title contain the useful identity. Operators cannot reliably distinguish approvals without fetching raw API records.

**Needed:**
1. Add a deterministic fixture-based test for task-start and merge approval records, then update the jq projection to show payload action, identifier or issue id, and payload title while retaining approval id, type, and status.

---
<!-- id: issue-20260907-182400-187-show-actionable-metadata-in-fleet-approval-listing  file: issue-20260907-182400-187-show-actionable-metadata-in-fleet-approval-listing.md -->
