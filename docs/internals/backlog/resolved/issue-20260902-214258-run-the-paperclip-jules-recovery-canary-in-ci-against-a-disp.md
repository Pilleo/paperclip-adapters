---
title: "Run the Paperclip Jules recovery canary in CI against a disposable server"
severity: "HIGH"
status: "open"
orchestrator_managed: true
priority: high
dependencies: []
component: "ci"
target_modules:
  - "packages/orchestrator"
  - "@pilleo/paperclip-orchestrator-adapter"
target_files:
  - "packages/orchestrator/scripts/e2e-jules-recovery.ts"
needs_kernel: false
core_lock: false
effort: "large"
autonomy: "supervised"
open_questions: false
has_side_effects: true

paperclip_issue_id: "029bf241-9035-4ae2-9337-063541da5379"
paperclip_identifier: "MAZ-955"
---

# 🔴 [Severity: HIGH]: Run the Paperclip Jules recovery canary in CI against a disposable server

**Context:**
Change 'Run the Paperclip Jules recovery canary in CI against a disposable server' in packages/orchestrator/scripts/e2e-jules-recovery.ts. Deterministic planner (no ACP). Replace if a human writes a tighter Context.

**Needed:**
1. Change `packages/orchestrator/scripts/e2e-jules-recovery.ts` for 'Run the Paperclip Jules recovery canary in CI against a disposable server'. Fail closed (no silent EPERM/EACCES bypass).
2. Run `npm run test -w @pilleo/paperclip-orchestrator-adapter`.

## Investigation
- AST identifier scan: 0 hits outside origin files

## Side effects
- CI must not create real Jules sessions or mutate GitHub

---

**Verification:** `npm run build -w @pilleo/paperclip-orchestrator-adapter` and `npm run test -w @pilleo/paperclip-orchestrator-adapter`.

<!-- id: issue-20260902-214258  file: issue-20260902-214258-run-the-paperclip-jules-recovery-canary-in-ci-against-a-disp.md -->
<!-- Agent: fill Context and Needed; add files/symbols if the impact walk missed them. Do not rename the file. -->
