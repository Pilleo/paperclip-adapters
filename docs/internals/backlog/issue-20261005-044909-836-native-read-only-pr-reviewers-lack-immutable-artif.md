---
title: "Native read-only PR reviewers lack immutable artifacts and can finish without verdicts"
severity: "HIGH"
status: "resolved"
priority: high
dependencies: []
component: "native-review"
target_modules: [orchestrator, antigravity]
target_files: 
  - "packages/antigravity/src/server/index.ts"
  - "packages/antigravity/src/server/native-review-completion.ts"
  - "packages/orchestrator/src/core/native-review-artifact.ts"
target_symbols: 
  - "execute"
open_questions: false
---

# 🟡 [Severity: HIGH]: Native read-only PR reviewers lack immutable artifacts and can finish without verdicts

**Context:**
PR27 strong reviewer could not inspect its private immutable head because shell tools were denied, then returned succeeded with no native verdict; host generic continuations repeated this unresolved work.

**Needed:**
1. [x] Provide SHA-pinned source/diff through the existing native assignment tool without relaxing model shell policy.
2. [x] Verify exact addressed-card, current resolver, prior recorded-target and host status-only contracts before claiming native completion.
3. [x] Finish final baseline/candidate real ACP positive and prose-only negative qualification and verified deployment; startup package loads and heartbeat `9b90df41-59b8-42ff-b92a-58d3853a0ca8` verified.

**Evidence:** `docs/superpowers/evidence/2026-10-05-native-pr-artifact-and-completion.md`.

---
<!-- id: issue-20261005-044909-836-native-read-only-pr-reviewers-lack-immutable-artif  file: issue-20261005-044909-836-native-read-only-pr-reviewers-lack-immutable-artif.md -->
