---
title: "Rebuild the server-backed Jules recovery canary from current master"
severity: "HIGH"
status: "open"
priority: high
dependencies: []
component: "ci"
orchestrator_managed: true
autonomy: "supervised"
has_side_effects: true
target_modules:
  - "packages/orchestrator"
  - "@pilleo/paperclip-orchestrator-adapter"
target_files:
  - ".github/workflows/paperclip-ci.yml"
  - "packages/orchestrator/scripts/e2e-jules-recovery.ts"
  - "packages/orchestrator/src/core/recovery-canary-state.ts"
  - "packages/orchestrator/test/recovery-canary-cleanup.test.ts"
  - "packages/orchestrator/test/recovery-canary-state.test.ts"
target_symbols:
  - "projectRecoveryCanaryState"
open_questions: false

paperclip_issue_id: "d4382eb9-72f4-4576-b824-3f7d09723b70"
paperclip_identifier: "MAZ-1456"
---

# 🟡 [Severity: HIGH]: Rebuild the server-backed Jules recovery canary from current master

**Context:**
MAZ-1435 and open PR #8 overlap the already-merged fixture hardening but PR #8 is conflicted and its Node 24 workflow failed. Replace that stale branch with one clean, independently reviewable implementation based on current master; do not reuse PR #8 commits or its blocked legacy dependency.

**Needed:**
1. Start a fresh branch from current `master`. Do not revive, merge, rebase, or copy commits from PR #8; its conflicted history is retired.
2. Write the failing tests first, then rebuild the disposable server-backed recovery canary and its CI wiring from the current Paperclip contract.
3. Keep the production board, GitHub repository, and Jules provider isolated: the canary may create only disposable Paperclip data and must never receive `JULES_API_KEY`.

## TDD requirements

1. Add failing unit tests for the recovery-state projection and cleanup path before modifying either implementation. Cover successful cleanup, non-2xx agent/company deletion, and `EPERM`/`EACCES`; cleanup failures must fail the canary and retain the original operation error when both fail.
2. Add or update the server-backed E2E canary so it proves, against a disposable Paperclip instance: a recovered ready Jules PR produces exactly one Luna native review card, Luna approval produces exactly one Terra card, Terra approval produces exactly one merge-approval path, and a repeated heartbeat is server-observed idempotent across issue state, cards, children, work products, approvals, and relevant runs.
3. Make the CI fixture fail closed. Install the deterministic fake `gh` on the server process `PATH` before Paperclip starts; enumerate every permitted CLI argv exactly and reject all others. The fixture and canary must not use real GitHub credentials or create a Jules session.
4. Use only supported Paperclip lifecycle commands. The disposable control plane runs on the runtime required by its pinned Paperclip version; restore the repository's matrix runtime before running the adapter/client test. Health checks, startup, shutdown, and teardown must have bounded timeouts and surface all failures.

## Acceptance criteria

- A clean branch based on current `master` passes the focused recovery-canary unit tests, `pnpm --filter @pilleo/paperclip-orchestrator-adapter test`, `pnpm --filter @pilleo/paperclip-orchestrator-adapter build`, and the focused server-backed E2E command against the disposable server.
- CI contains no Docker invocation, unsupported `paperclip-server` package, real GitHub mutation, real Jules wake/session, or secret projection into the canary process.
- The canary demonstrates the exact Luna → Terra → merge-approval ordering with one native card/run per stage and proves repeat-heartbeat idempotency from server-observed state.
- The resulting PR is independent of PR #8, references this issue, and is reviewable without conflict resolution from that retired branch.

## Supersession

This item supersedes MAZ-1435 and GitHub PR #8. MAZ-1435's stale task-start approval must be retired rather than approved. This task has no dependency on the blocked legacy `issue-20260904-120000` item.

## Verification

Run the focused tests after each implementation slice. Before submitting, run the package build/test commands above and the disposable-server E2E canary with its server-owned `gh` fixture. Record failures verbatim; do not weaken assertions or introduce cleanup bypasses to make CI pass.

---
<!-- id: issue-20260913-160435-801-rebuild-the-server-backed-jules-recovery-canary-fr  file: issue-20260913-160435-801-rebuild-the-server-backed-jules-recovery-canary-fr.md -->
