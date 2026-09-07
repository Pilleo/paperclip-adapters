---
title: "Extract a typed Paperclip disposable-environment E2E client"
severity: "MEDIUM"
status: "open"
orchestrator_managed: true
priority: medium
dependencies: []
component: "testing"
target_modules:
  - "packages/orchestrator"
  - "@pilleo/paperclip-orchestrator-adapter"
target_files:
  - "packages/orchestrator/scripts/e2e-paperclip-lifecycle.ts"
  - "packages/orchestrator/scripts/e2e-jules-recovery.ts"
needs_kernel: false
core_lock: false
effort: "medium"
autonomy: "autonomous"
open_questions: false
has_side_effects: true

paperclip_issue_id: "071909cf-01fe-4726-b2e4-712dedfd61cc"
paperclip_identifier: "JUL-5"
---

# 🟡 [Severity: MEDIUM]: Extract a typed Paperclip disposable-environment E2E client

**Context:**
Change 'Extract a typed Paperclip disposable-environment E2E client' in packages/orchestrator/scripts/e2e-paperclip-lifecycle.ts, packages/orchestrator/scripts/e2e-jules-recovery.ts. Deterministic planner (no ACP). Replace if a human writes a tighter Context.

**Needed:**
1. Change `packages/orchestrator/scripts/e2e-paperclip-lifecycle.ts` for 'Extract a typed Paperclip disposable-environment E2E client'. Fail closed (no silent EPERM/EACCES bypass).
2. Change `packages/orchestrator/scripts/e2e-jules-recovery.ts` for 'Extract a typed Paperclip disposable-environment E2E client'. Fail closed (no silent EPERM/EACCES bypass).
3. Run `npm run test -w @pilleo/paperclip-orchestrator-adapter`.

## Investigation
- AST identifier scan: 0 hits outside origin files

## Side effects
- Shared setup must preserve disposable-company cleanup and authentication boundaries

---

**Verification:** `npm run build -w @pilleo/paperclip-orchestrator-adapter` and `npm run test -w @pilleo/paperclip-orchestrator-adapter`.

<!-- id: issue-20260902-214257  file: issue-20260902-214257-extract-a-typed-paperclip-disposable-environment-e2e-client.md -->
<!-- Agent: fill Context and Needed; add files/symbols if the impact walk missed them. Do not rename the file. -->
