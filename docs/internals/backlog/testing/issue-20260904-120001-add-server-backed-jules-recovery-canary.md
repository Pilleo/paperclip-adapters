---
title: "Add a clean server-backed Jules recovery canary to CI"
severity: "HIGH"
status: "open"
orchestrator_managed: true
priority: high
dependencies:
  - "issue-20260904-120000"
component: "ci"
target_modules:
  - "packages/orchestrator"
  - "@pilleo/paperclip-orchestrator-adapter"
target_files:
  - ".github/workflows/paperclip-ci.yml"
  - "packages/orchestrator/scripts/e2e-jules-recovery.ts"
needs_kernel: false
core_lock: false
effort: "medium"
autonomy: "supervised"
open_questions: false
has_side_effects: true


paperclip_issue_id: "fa3232a3-5299-4f05-bba4-73c40133677d"
paperclip_identifier: "JUL-12"
---

# 🔴 [Severity: HIGH]: Add a clean server-backed Jules recovery canary to CI

## Context

PR #4 attempted this canary but used an obsolete lifecycle harness and a nonexistent `paperclip-server` npm package. The replacement must test the actual external adapter boundary against a disposable Paperclip instance and must be safe even on a runner with GitHub or Jules credentials.

## Needed:

1. Add the disposable Paperclip server-backed recovery canary and CI wiring described below.
2. Run the focused E2E canary plus the required build, typecheck, and package tests.

## TDD requirements

1. Add failing assertions for the complete recovery sequence: registered Jules PR with green CI → one Luna native review card → Luna approval → one Terra native review card → Terra approval → one merge-approval path.
2. Add a repeat-heartbeat assertion that snapshots and canonicalizes fresh server state before and after the second heartbeat, covering the issue, interactions, children, work products, approvals, and relevant runs.
3. Add isolation assertions that the fake `gh` is installed before server startup, every unexpected command fails, no Jules API key is present, and no real provider wake/session can occur.
4. Start the disposable server only through supported `paperclipai onboard` and `paperclipai run` commands in temporary directories; poll health with a bounded timeout and fail loudly on startup or teardown errors.
5. Implement the canary and CI wiring. Run the existing E2E test after each slice, then run the full build, typecheck, package tests, and the canary on both supported Node versions.

## Acceptance criteria

- CI does not use Docker or `npx paperclip-server`.
- The server-process `gh` fixture is active before the first orchestrator heartbeat and rejects all unapproved commands.
- The canary proves Luna precedes Terra, each review stage has one card/run, and repeated heartbeats are server-observed idempotent.
- Teardown surfaces non-success responses and `EPERM`/`EACCES`; no failure is swallowed.
- CI passes without real GitHub mutations, Jules sessions, credentials, or review spam.

## Side effects

All mutations are confined to a disposable Paperclip data directory and temporary test company. No production Paperclip issue or provider is touched.

---

**Verification:** E2E after each slice; full package build/test/typecheck; CI canary on Node 22 and 24.

<!-- id: issue-20260904-120001  file: issue-20260904-120001-add-server-backed-jules-recovery-canary.md -->
