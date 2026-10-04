---
title: "Native plan review admission misclassifies agent errors and stranded pending children"
severity: "MEDIUM"
status: "open"
priority: high
dependencies: []
component: "core"
target_modules: []
target_files: 
  - "packages/common/src/child-plan-review-parent.ts"
target_symbols: 
  - "reconcileChildPlanReview"
open_questions: false
---

# 🟡 [Severity: MEDIUM]: Native plan review admission misclassifies agent errors and stranded pending children

**Context:**
Live remaining campaign tasks wait indefinitely: a strong reviewer last-run error prevents scoped bootstrap, and an existing pending Luna card has no active run after an unstarted queue cancellation.

**Needed:**
1. Add red regressions for administrative-state admission and exact pending-card idle recovery, preserving native source and run provenance.

---
<!-- id: issue-20261004-142659-330-native-plan-review-admission-misclassifies-agent-e  file: issue-20261004-142659-330-native-plan-review-admission-misclassifies-agent-e.md -->
