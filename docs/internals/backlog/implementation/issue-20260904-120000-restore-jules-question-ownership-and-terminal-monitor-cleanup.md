---
title: "Restore Jules native-question ownership and terminal-monitor cleanup"
severity: "HIGH"
status: "open"
orchestrator_managed: true
priority: high
dependencies: []
component: "orchestrator"
target_modules:
  - "packages/jules"
  - "packages/orchestrator"
target_files:
  - "packages/jules/src/server/execute.ts"
  - "packages/jules/src/server/question-workflow.ts"
  - "packages/orchestrator/src/server/execute.ts"
needs_kernel: false
core_lock: false
effort: "medium"
autonomy: "autonomous"
open_questions: false
has_side_effects: true


paperclip_issue_id: "5ffdcdbd-cd86-4ada-b63d-c0dbcca159e9"
paperclip_identifier: "JUL-8"
---

# 🔴 [Severity: HIGH]: Restore Jules native-question ownership and terminal-monitor cleanup

## Context

MAZ-955 accumulated duplicate review cards and hundreds of monitor attempts because a provider question could remain pending after the source issue lost its assignee. The provider question must be represented by one native Paperclip card and one durable adjudicator execution. Provider completion and PR handoff must also terminate the Jules monitor instead of leaving a stale external timer active.

## Needed:

1. Add the typed question-ownership and terminal-monitor state-machine behavior described below.
2. Add the required regression tests and run the focused Jules/orchestrator suites.

## TDD requirements

1. Add parameterized pure-state tests covering pending, answered, malformed, superseded, and escalated native question cards combined with assigned/unassigned source issues and absent/active/terminal reviewer runs.
2. Add tests proving repeated reconciliation reuses the same adjudication card and wake, relays one answer at most, and never falls back to a prose comment.
3. Add tests proving terminal Jules states and completed PR handoff clear or invalidate the Jules monitor, while a genuinely active provider session remains resumable.
4. Add a regression proving that a pre-approved dependent issue cannot enter a worker lane until every persisted Paperclip `blockedBy` edge is terminal; normalize UUID blocker IDs through the dispatcher.
5. Implement the smallest typed state-machine/reconciliation changes needed to satisfy those tests. Use exhaustive switches for finite states and preserve Paperclip's native interaction contract.
6. Run focused Jules and orchestrator tests after each implementation slice, then run both full package suites and the repository typecheck.

## Acceptance criteria

- A pending Jules provider question always has one durable owner and exactly one addressed Terra adjudication path.
- Repeated heartbeats do not create duplicate cards, child issues, comments, or reviewer wakes.
- Structured `ANSWER` and `ESCALATE` decisions are relayed exactly once and are visible on the parent issue.
- A terminal provider/PR state cannot retain a live Jules monitor or continue polling.
- All existing tests, typechecks, and coverage thresholds pass.

## Side effects

Only Paperclip control-plane state and local adapter code are changed. Tests must not create real Jules sessions, call real GitHub, or expose credentials.

---

**Verification:** focused tests after each slice; full Jules/orchestrator suites; `npm run typecheck`; no provider-side calls.

<!-- id: issue-20260904-120000  file: issue-20260904-120000-restore-jules-question-ownership-and-terminal-monitor-cleanup.md -->
