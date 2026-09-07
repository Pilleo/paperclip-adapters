---
title: "Add deduplicated recovery and authentication incident telemetry"
severity: "HIGH"
status: "open"
orchestrator_managed: true
priority: high
dependencies: []
component: "orchestrator"
target_modules:
  - "packages/orchestrator"
  - "@pilleo/paperclip-orchestrator-adapter"
target_files:
  - "packages/orchestrator/src/server/execute.ts"
  - "packages/orchestrator/src/core/incident-deduper.ts"
needs_kernel: false
core_lock: false
effort: "medium"
autonomy: "autonomous"
open_questions: false
has_side_effects: true

paperclip_issue_id: "a9935358-470e-4e2f-8e2f-0bb511fd3eca"
paperclip_identifier: "JUL-7"
---

# 🔴 [Severity: HIGH]: Add deduplicated recovery and authentication incident telemetry

**Context:**
Change 'Add deduplicated recovery and authentication incident telemetry' in packages/orchestrator/src/server/execute.ts, packages/orchestrator/src/core/incident-deduper.ts. Deterministic planner (no ACP). Replace if a human writes a tighter Context.

**Needed:**
1. Change `packages/orchestrator/src/server/execute.ts` for 'Add deduplicated recovery and authentication incident telemetry'. Fail closed (no silent EPERM/EACCES bypass).
2. Change `packages/orchestrator/src/core/incident-deduper.ts` for 'Add deduplicated recovery and authentication incident telemetry'. Fail closed (no silent EPERM/EACCES bypass).
3. Run `npm run test -w @pilleo/paperclip-orchestrator-adapter`.

## Investigation
- AST identifier scan: 0 hits outside origin files

## Side effects
- Operational signals must identify one incident without heartbeat spam

---

**Verification:** `npm run build -w @pilleo/paperclip-orchestrator-adapter` and `npm run test -w @pilleo/paperclip-orchestrator-adapter`.

<!-- id: issue-20260902-214300  file: issue-20260902-214300-add-deduplicated-recovery-and-authentication-incident-teleme.md -->
<!-- Agent: fill Context and Needed; add files/symbols if the impact walk missed them. Do not rename the file. -->
