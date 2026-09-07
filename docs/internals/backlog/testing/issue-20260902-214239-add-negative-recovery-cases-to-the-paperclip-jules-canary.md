---
title: "Add negative recovery cases to the Paperclip Jules canary"
severity: "HIGH"
status: "open"
orchestrator_managed: true
priority: high
dependencies: []
component: "testing"
target_modules:
  - "packages/orchestrator"
  - "@pilleo/paperclip-orchestrator-adapter"
target_files:
  - "packages/orchestrator/scripts/e2e-jules-recovery.ts"
needs_kernel: false
core_lock: false
effort: "medium"
autonomy: "autonomous"
open_questions: false
has_side_effects: true

paperclip_issue_id: "831321df-1c14-4a03-b311-abf552228d62"
paperclip_identifier: "JUL-11"
---

# 🔴 [Severity: HIGH]: Add negative recovery cases to the Paperclip Jules canary

**Context:**
Change 'Add negative recovery cases to the Paperclip Jules canary' in packages/orchestrator/scripts/e2e-jules-recovery.ts. Deterministic planner (no ACP). Replace if a human writes a tighter Context.

**Needed:**
1. Change `packages/orchestrator/scripts/e2e-jules-recovery.ts` for 'Add negative recovery cases to the Paperclip Jules canary'. Fail closed (no silent EPERM/EACCES bypass).
2. Run `npm run test -w @pilleo/paperclip-orchestrator-adapter`.

## Investigation
- AST identifier scan: 0 hits outside origin files

## Side effects
- The canary must prove unsafe PR states are not recovered

---

**Verification:** `npm run build -w @pilleo/paperclip-orchestrator-adapter` and `npm run test -w @pilleo/paperclip-orchestrator-adapter`.

<!-- id: issue-20260902-214239  file: issue-20260902-214239-add-negative-recovery-cases-to-the-paperclip-jules-canary.md -->
<!-- Agent: fill Context and Needed; add files/symbols if the impact walk missed them. Do not rename the file. -->
