---
title: "E2E: prove pre-approved dependent tasks dispatch only after native blockers resolve"
severity: "HIGH"
status: "open"
orchestrator_managed: true
priority: high
dependencies:
  - "MAZ-1528"
component: "testing"
target_modules:
  - "packages/orchestrator"
target_files:
  - "packages/orchestrator/scripts/e2e-paperclip-lifecycle.ts"
  - "packages/orchestrator/test/e2e-paperclip-lifecycle.test.ts"
needs_kernel: false
core_lock: false
effort: "medium"
autonomy: "autonomous"
open_questions: false
has_side_effects: true

paperclip_issue_id: "e1506982-316b-4af7-aeb8-c653a5c5a4ca"
paperclip_identifier: "MAZ-1529"
---

# 🔴 [Severity: HIGH]: E2E: prove pre-approved dependent tasks dispatch only after native blockers resolve

**Context:**

The approval and dependency mechanisms need a server-backed regression that verifies their combined behavior against a real Paperclip lifecycle, rather than asserting only isolated helper behavior.

**Needed:**

1. Build a predecessor/dependent pair in a disposable, server-backed Paperclip environment.
2. Ensure both `task_start` approvals are created before the predecessor is terminal.
3. Approve the dependent before the predecessor and prove no dependent worker run can start.
4. Terminalize the predecessor and prove the dependent dispatches exactly once.

## TDD requirements

1. Start with failing assertions for the full lifecycle and native `blockedByIssueIds` relation.
2. Add repeat-heartbeat assertions that no approval or worker run is duplicated.
3. Use real SQLite/Paperclip state; do not mock database calls or external state-machine transitions.
4. Run the focused E2E script after each implementation slice, then package tests and typecheck.

## Acceptance criteria

- Both chain cards are visible and approvable at creation time.
- Early dependent approval is durable but cannot bypass its native blocker.
- Once the predecessor is terminal, one and only one dependent dispatch is allowed.
- Repeated reconciliation is idempotent for approvals, blockers, and worker runs.

## Side effects

All mutations are confined to the disposable Paperclip test server. No production provider session or GitHub repository may be contacted.

---

**Verification:** focused server-backed E2E after each slice; full orchestrator suite and typecheck before delivery.

<!-- id: issue-20260917-000002-e2e-preapproved-dependent-tasks-dispatch-after-native-blockers  file: issue-20260917-000002-e2e-preapproved-dependent-tasks-dispatch-after-native-blockers.md -->
