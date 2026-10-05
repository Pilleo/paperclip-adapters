---
title: "Align adapter and plugin SDK dependencies with Paperclip 2026.1001.0"
severity: "MEDIUM"
status: "resolved"
priority: high
dependencies: []
component: "sdk"
target_modules: [orchestrator, jules, antigravity, vibe, telegram]
target_files: 
  - "packages/orchestrator/package.json"
target_symbols: 
  - "dependencies"
open_questions: false
---

# 🟡 [Severity: MEDIUM]: Align adapter and plugin SDK dependencies with Paperclip 2026.1001.0

**Context:**
The live host is 2026.1001.0 but external adapters and the plugin resolved SDK 2026.916.0. The user requested matching SDK pins and lockfile, with runtime qualification and a live reload.

**Needed:**
1. [x] Update exact adapter-utils/plugin-sdk pins and regenerate a reproducible pnpm lockfile.
2. [x] Pass builds, full workspace tests, negative type invariants, and all five SDK runtime qualification lanes.
3. [x] Reload the live adapters, verify startup entrypoints and a succeeding heartbeat, and confirm actual resolved SDK versions.

**Evidence:** `docs/superpowers/evidence/2026-10-05-sdk-1001-alignment.md`.

---
<!-- id: issue-20261005-131020-827-align-adapter-and-plugin-sdk-dependencies-with-pap  file: issue-20261005-131020-827-align-adapter-and-plugin-sdk-dependencies-with-pap.md -->
