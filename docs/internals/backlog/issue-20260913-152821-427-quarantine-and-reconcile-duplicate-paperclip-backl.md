---
title: "Quarantine and reconcile duplicate Paperclip backlog imports"
severity: "HIGH"
status: "open"
priority: high
dependencies:
  - "MAZ-1450"
component: "orchestrator"
orchestrator_managed: true
autonomy: "autonomous"
has_side_effects: true
target_modules:
  - "packages/orchestrator"
target_files:
  - "packages/orchestrator/src/core/backlog-sync.ts"
  - "packages/orchestrator/src/server/execute.ts"
target_symbols:
  - "syncBacklogMarkdownToPaperclip"
  - "resolveBacklogIssueCandidates"
open_questions: false

paperclip_issue_id: "38acbae1-49e4-4f4f-97b9-dc211f2414f0"
paperclip_identifier: "MAZ-1452"
---

# 🟡 [Severity: HIGH]: Quarantine and reconcile duplicate Paperclip backlog imports

**Context:**
The Paperclip project currently contains multiple active tasks for identical source backlog files. Existing title matching avoids some future duplicates but does not make one canonical record authoritative, does not protect dispatch, and does not repair idle duplicates safely.

**Needed:**
1. Define a typed canonical backlog-source identity from the source filename/id, project id, declared `paperclip_issue_id`, and canonical formatted title. The source file's declared Paperclip id wins only when it agrees with that identity; title-only collisions are never treated as safe identity.
2. Group imported Paperclip issues by that identity before scheduling. Select one canonical candidate deterministically and expose all non-canonical candidates as quarantined; quarantined rows must not be considered by dispatch, recovery, or new-session admission.
3. Cancel a duplicate only when it is provably idle: it has no execution run, pending interaction, work product, or active ownership. Preserve audit evidence with one idempotent record.
4. For an ambiguous or active duplicate, preserve the task, keep it quarantined, and create exactly one human-only Paperclip interaction describing the candidates and safe resolution choices. Never auto-cancel a task with an active provider session, review, PR, or form.
5. Keep the existing source-backlog import contract intact and ensure synchronization holds prevent import writes before local checkout freshness is proven.

**TDD requirements:**
1. Write parameterized red tests for declared-id match/mismatch, duplicate titles across projects, legacy title-only collisions, safe idle duplicates, active-run duplicates, pending-card duplicates, and PR-bearing duplicates.
2. Add an integration test using the current duplicate shape: one canonical source record plus historical Paperclip duplicates. Assert exactly one is schedulable and only safe idle duplicates become cancelled.
3. Verify a retry cannot create duplicate cancellation comments or user cards.
4. Run focused tests red/green, the full orchestrator suite, `pnpm test`, `pnpm build`, reload, and the disposable lifecycle E2E.

**Acceptance criteria:**
- One source backlog task has at most one schedulable Paperclip issue.
- Historical records are preserved unless they satisfy the explicit idle predicate.
- Ambiguous records are visible as a single human-only decision, never hidden or repeatedly spammed.

---
<!-- id: issue-20260913-152821-427-quarantine-and-reconcile-duplicate-paperclip-backl  file: issue-20260913-152821-427-quarantine-and-reconcile-duplicate-paperclip-backl.md -->
