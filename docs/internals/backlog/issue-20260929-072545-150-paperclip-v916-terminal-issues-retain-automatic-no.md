---
title: "Paperclip v916 terminal issues retain automatic no-replay execution blocker"
severity: "HIGH"
status: "open"
priority: high
dependencies: []
component: "core"
target_modules: []
target_files:
  - "packages/orchestrator/test/contract/terminal-auto-blocker.mjs"
target_symbols:
  - "getExecutionBlocker"
open_questions: false
---

# 🟡 [Severity: HIGH]: Paperclip v916 terminal issues retain automatic no-replay execution blocker

**Context:**
Pinned Paperclip 2026.916.0 real-PostgreSQL repro: a host-created failed run is automatically settled outcome blocked with automaticRecovery.replay blocked; after a board-owned merged work product and terminal issue transition, GET issue reports done and actionable legacy_execution_requires_reconciliation. Strict qualification exits 2. Preserve audit without allowing provider replay.

**Needed:**
1. Fix and version-qualify the upstream Paperclip execution-blocker read model so resolved automatic no-replay history remains auditable but cannot appear as a current actionable blocker on done issues; rerun pnpm test:contract:terminal-blocker --require-safe.

---
<!-- id: issue-20260929-072545-150-paperclip-v916-terminal-issues-retain-automatic-no  file: issue-20260929-072545-150-paperclip-v916-terminal-issues-retain-automatic-no.md -->
