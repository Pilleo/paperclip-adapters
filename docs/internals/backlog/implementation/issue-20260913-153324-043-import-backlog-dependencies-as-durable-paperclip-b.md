---
title: "Import backlog dependencies as durable Paperclip blocker edges"
severity: "HIGH"
status: "open"
orchestrator_managed: true
priority: high
dependencies:
  - "MAZ-1450"
component: "orchestrator"
target_modules:
  - "packages/orchestrator"
target_files:
  - "packages/orchestrator/src/core/backlog-sync.ts"
  - "packages/orchestrator/src/core/dependency-gate.ts"
  - "packages/orchestrator/test/backlog-sync.test.ts"
needs_kernel: false
core_lock: false
effort: "medium"
autonomy: "autonomous"
open_questions: false
has_side_effects: true

paperclip_issue_id: "d6ceeb59-a90b-47e6-a079-b3e39f7b38f7"
paperclip_identifier: "MAZ-1455"
---

# 🔴 [Severity: HIGH]: Import backlog dependencies as durable Paperclip blocker edges

## Context

The source backlog records dependency references, but the importer currently creates Paperclip issues without persisting those relationships into native `blockedByIssueIds`. A managed dependent task can therefore become runnable solely because a source document was imported, rather than because its durable predecessor has reached a terminal state.

## Needed

1. Resolve source dependency references to exact same-project Paperclip issues by UUID, identifier, or source backlog ID.
2. Reconcile only source-owned blocker edges while preserving externally owned edges.
3. Fail closed when a source dependency cannot be resolved.
4. Keep repeated imports idempotent and remove a source-owned edge only when the source dependency is removed.

## TDD requirements

1. Add failing parameterized tests for empty, UUID, identifier, source-ID, duplicate, unresolved, and cross-project references.
2. Add server-backed lifecycle coverage showing that a persisted blocker prevents dispatch until its predecessor is terminal.
3. Implement the smallest typed reconciliation change required to pass the tests, then run focused tests after each slice.

## Acceptance criteria

- Canonical source dependencies are represented by native Paperclip `blockedByIssueIds`.
- Existing external blocker edges survive import reconciliation.
- Unresolvable dependencies leave the issue safely blocked and produce actionable diagnostics.
- Repeated heartbeats neither duplicate nor erase durable dependency edges.

## Side effects

This changes Paperclip control-plane dependency state only; it must not start workers or create provider sessions.

---

**Verification:** focused importer and dependency-gate tests after each slice; full orchestrator suite and typecheck before delivery.

<!-- id: issue-20260913-153324-043-import-backlog-dependencies-as-durable-paperclip-b  file: issue-20260913-153324-043-import-backlog-dependencies-as-durable-paperclip-b.md -->
