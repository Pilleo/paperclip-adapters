---
title: "Configure Paperclip project workspace synchronization policy"
severity: "HIGH"
status: "open"
priority: high
dependencies:
  - "MAZ-1450"
component: "orchestrator"
orchestrator_managed: true
autonomy: "autonomous"
has_side_effects: true
target_modules:
  - "packages/orchestrator"
target_files:
  - "packages/orchestrator/src/core/parser.ts"
  - "packages/orchestrator/src/server/execute.ts"
  - "packages/orchestrator/scripts/e2e-paperclip-lifecycle.ts"
target_symbols:
  - "resolveProjectWorkspace"
  - "executeProject"
open_questions: false

paperclip_issue_id: "4821953a-3693-4439-a322-a2aa4b226ecc"
paperclip_identifier: "MAZ-1451"
---

# 🟡 [Severity: HIGH]: Configure Paperclip project workspace synchronization policy

**Context:**
Project workspaces do not presently carry an explicit default ref into the custom orchestrator. The live Paperclip project needs a declarative default branch and HTTPS transport so a safe fast-forward sync can be executed without trusting the dirty checkout's SSH origin configuration.

**Needed:**
1. Extend the typed project-workspace contract so `repoUrl`, `repoRef`, and `defaultRef` survive parsing and are available to the synchronization state machine. Missing or invalid values must be an explicit fail-closed disposition, never an implicit fallback to the local branch.
2. Add a board-safe, idempotent project-policy reconciliation path for the current Paperclip project: retain `https://github.com/Pilleo/paperclip-adapters.git`, set `defaultRef` to `master`, and preserve the developer-owned local `cwd`. Re-read the project after the write and report the resulting workspace metadata without secrets.
3. Do not change a local branch, git remote, or worktree from this configuration path. The synchronization task owns the only permitted fast-forward operation after it has proved the checkout safe.
4. Make configuration convergence visible in the orchestrator heartbeat summary. A failed project-policy write is loud, prevents new work starts, and follows the same human-only sync card path rather than silently guessing a branch.

**TDD requirements:**
1. Write a red parser/integration test that the declared Paperclip HTTPS URL and default ref drive the sync target even when the local git `origin` uses SSH or a different branch.
2. Extend the disposable Paperclip lifecycle harness to create a project with a declared default ref, run configuration reconciliation twice, and prove the second pass is a no-op.
3. Add a failure test proving absent/default-ref mismatch does not modify local Git and prevents new dispatch.
4. Run focused tests red/green, the orchestrator suite, workspace `pnpm test` and `pnpm build`, then reload the adapter and verify one live heartbeat reads the configured project policy.

**Acceptance criteria:**
- Project metadata, rather than ambient Git configuration, is the synchronization authority.
- The live `paperclip-adapters` project declares `master` and its HTTPS repository URL.
- Reconciliation is idempotent and never edits the developer checkout.

---
<!-- id: issue-20260913-152816-288-configure-paperclip-project-workspace-synchronizat  file: issue-20260913-152816-288-configure-paperclip-project-workspace-synchronizat.md -->
