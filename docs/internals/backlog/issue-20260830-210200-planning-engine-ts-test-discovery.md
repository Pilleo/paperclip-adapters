---
title: "Host plan synthesizer discovers TypeScript tests next to npm packages"
severity: "MEDIUM"
priority: "medium"
status: "open"
orchestrator_managed: true
component: "tools"
target_modules: ["packages/common", "@pilleo/paperclip-adapter-common"]
target_files:
  - "packages/common/src/planning-engine.ts"
  - "packages/common/test/planning-engine.test.ts"
target_symbols:
  - "synthesizeDeterministicPlan"
  - "buildHostImplementationPlan"
open_questions: false
dependencies:
  - "issue-20260830-210100-backlog-linter-npm-workspaces"

paperclip_issue_id: "627bc22f-59b0-4e4c-bd79-e306691a3fb5"
paperclip_identifier: "JUL-9"
---

**Context:** `synthesizeDeterministicPlan` already guesses `src/main` → `src/test` and `.test.ts` siblings, but it does not look at `packages/<name>/test/*.test.ts` for this monorepo. Host short plans for Jules/orchestrator issues therefore omit the real test files.

**Needed:** When `workspacePath` is this repo, if `target_files` includes `packages/jules/src/server/plan-reviewer.ts`, the plan `testFiles` must include existing `packages/jules/test/plan-reviewer.test.ts` (and the same pattern for other packages). Do not invent Gradle modules. Keep Codanna outlines on the plan when indexed.
