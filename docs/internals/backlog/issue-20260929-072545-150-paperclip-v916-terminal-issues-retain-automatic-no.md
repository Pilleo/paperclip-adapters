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

**Adapter-side recovery on the existing host:**
The same opt-in contract passes with `--typed-recover-before-terminal --require-safe`.
The board's native recovery route validates the exact failed run, stopped process,
and independently observed external action outcome while the original owner is
still assigned. The orchestrator now preserves that ownership and holds both
open-PR review handoff and merged-PR terminalization until this typed resolution
clears the effective blocker. This issue concerns direct host/board terminalization
that bypasses that supported adapter path; it is **not** permission to replay an
uncertain Jules effect or a prerequisite for using the adapter recovery route.

---
<!-- id: issue-20260929-072545-150-paperclip-v916-terminal-issues-retain-automatic-no  file: issue-20260929-072545-150-paperclip-v916-terminal-issues-retain-automatic-no.md -->
