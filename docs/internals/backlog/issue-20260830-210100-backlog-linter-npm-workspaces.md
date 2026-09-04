---
title: "Planning linter accepts npm workspaces, not only mazewall Gradle modules"
severity: "HIGH"
priority: "high"
status: "open"
component: "tools"
target_modules: ["packages/common", "@pilleo/paperclip-adapter-common"]
target_files:
  - "packages/common/src/linter.ts"
  - "packages/common/test/linter.test.ts"
target_symbols:
  - "isValidTargetModule"
  - "lintBacklogMarkdown"
  - "VALID_NPM_WORKSPACES"
open_questions: false
dependencies:
  - "issue-20260830-210000-plan-review-mistral-luna-terra-codex"

paperclip_issue_id: "8bccea52-28fb-45ca-8ddb-48ca48c44cf3"
paperclip_identifier: ""
---

**Context:** `lintBacklogMarkdown` required `target_modules` to be mazewall Gradle ids (`:enforcer`, …). Work packages in this adapters monorepo could not lint, so the planning tool could not be used here.

**Needed:** Accept `packages/jules` (and the other workspaces) plus `@pilleo/paperclip-*` as valid `target_modules` while still rejecting garbage like `core` as a module. Keep Gradle modules valid. Tests must cover both catalogs.
