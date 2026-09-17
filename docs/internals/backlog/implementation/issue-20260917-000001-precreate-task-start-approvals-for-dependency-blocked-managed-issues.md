---
title: "Pre-create task-start approvals for dependency-blocked managed issues"
severity: "HIGH"
status: "open"
orchestrator_managed: true
priority: high
dependencies:
  - "MAZ-1455"
component: "orchestrator"
target_modules:
  - "packages/orchestrator"
target_files:
  - "packages/orchestrator/src/server/execute.ts"
  - "packages/orchestrator/src/core/approvals.ts"
  - "packages/orchestrator/test/approvals.test.ts"
needs_kernel: false
core_lock: false
effort: "medium"
autonomy: "autonomous"
open_questions: false
has_side_effects: true

paperclip_issue_id: "68561d06-fbba-407b-8b26-5fdf810d8f42"
paperclip_identifier: "MAZ-1528"
---

# 🔴 [Severity: HIGH]: Pre-create task-start approvals for dependency-blocked managed issues

## Context

Managed issues receive a task-start approval only after they become runnable. That hides dependent cards from an operator until all predecessors complete, making it impossible to approve a whole dependency chain up front. Approval expresses operator intent; it must not weaken Paperclip's native blocker gate.

## Needed

1. Create or reuse one idempotent native `task_start` approval for every managed backlog/todo implementation issue, including dependency-blocked issues.
2. Preserve the authoritative dependency gate immediately before any worker dispatch.
3. Preserve rejected, terminal, and existing pending/approved approval semantics.

## TDD requirements

1. Add parameterized tests for no approval, pending, approved, rejected, terminal, and dependency-blocked combinations.
2. Prove that a blocked issue can receive and retain an approval while still producing no worker run.
3. Prove that repeated heartbeats do not duplicate approval cards or dispatches.
4. Run focused tests after each slice, then the full orchestrator suite and typecheck.

## Acceptance criteria

- Operators can approve every card in a managed dependency chain before execution begins.
- An approved dependent cannot dispatch until every native `blockedBy` predecessor is terminal.
- One issue has at most one live task-start approval for a given execution intent.
- Existing review and escalation cards remain unaffected.

## Side effects

Only Paperclip approval records are created. No provider wake or worker dispatch may result while blockers remain unresolved.

---

**Verification:** focused approval and execute tests after each slice; full orchestrator suite and typecheck before delivery.

<!-- id: issue-20260917-000001-precreate-task-start-approvals-for-dependency-blocked-managed-issues  file: issue-20260917-000001-precreate-task-start-approvals-for-dependency-blocked-managed-issues.md -->
