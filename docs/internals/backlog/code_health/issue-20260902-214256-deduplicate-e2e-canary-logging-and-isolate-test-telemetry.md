---
title: "Deduplicate E2E canary logging and isolate test telemetry"
severity: "LOW"
status: "open"
orchestrator_managed: true
priority: low
dependencies: []
component: "testing"
target_modules:
  - "packages/orchestrator"
  - "@pilleo/paperclip-orchestrator-adapter"
target_files:
  - "packages/orchestrator/scripts/e2e-jules-recovery.ts"
needs_kernel: false
core_lock: false
effort: "small"
autonomy: "autonomous"
open_questions: false
has_side_effects: true

paperclip_issue_id: "d7ec66ca-0935-4cb3-b0a2-b5922f5745a9"
paperclip_identifier: "MAZ-1139"
---

# 🟢 [Severity: LOW]: Deduplicate E2E canary logging and isolate test telemetry

**Context:**
Change 'Deduplicate E2E canary logging and isolate test telemetry' in packages/orchestrator/scripts/e2e-jules-recovery.ts. Deterministic planner (no ACP). Replace if a human writes a tighter Context.

**Needed:**
1. Change `packages/orchestrator/scripts/e2e-jules-recovery.ts` for 'Deduplicate E2E canary logging and isolate test telemetry'. Fail closed (no silent EPERM/EACCES bypass).
2. Run `npm run test -w @pilleo/paperclip-orchestrator-adapter`.

## Investigation
- AST identifier scan: 0 hits outside origin files

## Side effects
- Test output must represent one execution and remain diagnosable

---

**Verification:** `npm run build -w @pilleo/paperclip-orchestrator-adapter` and `npm run test -w @pilleo/paperclip-orchestrator-adapter`.

<!-- id: issue-20260902-214256  file: issue-20260902-214256-deduplicate-e2e-canary-logging-and-isolate-test-telemetry.md -->
<!-- Agent: fill Context and Needed; add files/symbols if the impact walk missed them. Do not rename the file. -->
