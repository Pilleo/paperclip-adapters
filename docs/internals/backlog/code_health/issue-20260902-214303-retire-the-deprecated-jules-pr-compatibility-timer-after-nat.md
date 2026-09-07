---
title: "Retire the deprecated Jules PR compatibility timer after native recovery validation"
severity: "LOW"
status: "open"
orchestrator_managed: true
priority: low
dependencies: []
component: "platform"
target_modules:
  - "packages/orchestrator"
  - "@pilleo/paperclip-orchestrator-adapter"
target_files:
  - "scripts/fleet/install_jules_pr_reconciler_timer.sh"
  - "scripts/fleet/reconcile_jules_prs.mjs"
needs_kernel: false
core_lock: false
effort: "medium"
autonomy: "supervised"
open_questions: false
has_side_effects: true

paperclip_issue_id: "564cbae7-2421-4e73-bf45-6df1882c9d53"
paperclip_identifier: "MAZ-1145"
---

# 🟢 [Severity: LOW]: Retire the deprecated Jules PR compatibility timer after native recovery validation

**Context:**
Change 'Retire the deprecated Jules PR compatibility timer after native recovery validation' in scripts/fleet/install_jules_pr_reconciler_timer.sh, scripts/fleet/reconcile_jules_prs.mjs. Deterministic planner (no ACP). Replace if a human writes a tighter Context.

**Needed:**
1. Change `scripts/fleet/install_jules_pr_reconciler_timer.sh` for 'Retire the deprecated Jules PR compatibility timer after native recovery validation'. Fail closed (no silent EPERM/EACCES bypass).
2. Change `scripts/fleet/reconcile_jules_prs.mjs` for 'Retire the deprecated Jules PR compatibility timer after native recovery validation'. Fail closed (no silent EPERM/EACCES bypass).
3. Run `npm run test -w @pilleo/paperclip-orchestrator-adapter`.

## Investigation
- AST identifier scan: 0 hits outside origin files

## Side effects
- Removing the bridge requires a verified native heartbeat rollback path

---

**Verification:** `npm run build -w @pilleo/paperclip-orchestrator-adapter` and `npm run test -w @pilleo/paperclip-orchestrator-adapter`.

<!-- id: issue-20260902-214303  file: issue-20260902-214303-retire-the-deprecated-jules-pr-compatibility-timer-after-nat.md -->
<!-- Agent: fill Context and Needed; add files/symbols if the impact walk missed them. Do not rename the file. -->
