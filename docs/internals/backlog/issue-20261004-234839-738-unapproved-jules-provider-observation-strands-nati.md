---
title: "Unapproved Jules provider observation strands native plan reviews in manual recovery"
severity: "HIGH"
status: "resolved"
priority: high
dependencies: []
component: "jules"
target_modules: [jules, orchestrator]
target_files: 
  - "packages/jules/src/server/plan-provider-decision.ts"
  - "packages/jules/src/server/execute.ts"
  - "packages/orchestrator/src/core/jules-execution-blocker-reconciliation.ts"
target_symbols: 
  - "decidePlanProviderAction"
open_questions: false
---

# 🟡 [Severity: HIGH]: Unapproved Jules provider observation strands native plan reviews in manual recovery

**Context:**
MAZ-1650 and MAZ-1740 reproduced on real Paperclip: plan-only IN_PROGRESS poll becomes failed legacy execution, prevents strong child activation and loses outputless COMPLETED continuation.

**Needed:**
1. [x] Reproduce provider drift and legacy hold migration through autonomous real-host contracts; preserve original session and typed verdict gates.
2. [x] Keep provider observations durable and pending while native review coordination advances independently of provider-write permission.
3. [x] Retain exact approval witnesses and typed verdict provenance across current and older native checkpoints.
4. [x] Record final reviewed qualification and normal-heartbeat convergence of the two original live issues, including successful strong native verdicts and one confirmed provider approval request each.

**Evidence:** `docs/superpowers/evidence/2026-10-05-plan-provider-observation-lifecycle.md`.

---
<!-- id: issue-20261004-234839-738-unapproved-jules-provider-observation-strands-nati  file: issue-20261004-234839-738-unapproved-jules-provider-observation-strands-nati.md -->
