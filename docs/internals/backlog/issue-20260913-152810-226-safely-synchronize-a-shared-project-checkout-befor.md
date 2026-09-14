---
title: "Safely synchronize a shared project checkout before scheduling new work"
severity: "HIGH"
status: "open"
priority: critical
dependencies: []
component: "orchestrator"
orchestrator_managed: true
autonomy: "autonomous"
has_side_effects: true
target_modules:
  - "packages/orchestrator"
target_files:
  - "packages/orchestrator/src/server/execute.ts"
  - "packages/orchestrator/src/core/consistency.ts"
  - "packages/orchestrator/src/core/parser.ts"
target_symbols:
  - "executeProject"
  - "checkWorkspaceConsistency"
  - "resolveProjectWorkspace"
open_questions: false

paperclip_issue_id: "01dbb648-095b-4f5e-b660-03947eb21369"
paperclip_identifier: "MAZ-1450"
---

# 🟡 [Severity: HIGH]: Safely synchronize a shared project checkout before scheduling new work

**Context:**
The orchestrator currently only warns when its project workspace is dirty or stale, then continues Markdown ingestion and new agent dispatch. Local reasoning can therefore run against an old merge base. Synchronization must preserve shared local work and use Paperclip forms when a human decision is necessary.

This is the prerequisite safety gate for all newly admitted implementation work in this shared checkout. It must be scheduled ahead of unrelated `high`-priority orchestrator tasks, while preserving normal file/module conflict exclusion.

**Needed:**
1. Model checkout observation and synchronization as exhaustive discriminated TypeScript unions. The evaluator must distinguish: up to date, clean and fast-forwardable, dirty, non-default branch, diverged, default-ref missing, remote unavailable, and command failure. Do not encode state with optional strings or ordered `if` chains.
2. Resolve the sync target only from Paperclip project workspace metadata: HTTPS `repoUrl` plus explicit `defaultRef`. Never trust or alter the local checkout's `origin` remote. For the current project the expected ref is `master`.
3. Before Markdown backlog ingestion or fresh scheduling, read the checkout state and probe the configured remote ref. Only a clean checkout already on that default branch may run `git pull --ff-only <repoUrl> <defaultRef>`; verify `HEAD` afterward. Never reset, stash, rebase, switch branches, force-pull, or modify a dirty/non-default/divergent tree.
4. When synchronization is unhealthy, keep existing Jules polling, answered-question reconciliation, native review cards, CI, remote PR checks, merge completion, and recovery paths active. Suppress only new backlog ingestion, new issue checkout/dispatch, fresh Jules sessions, and new reviewer-card/wakeup creation.
5. Attach exactly one idempotent `ask_user_questions` interaction to the highest-priority otherwise-runnable task that is being held. It must use `resolverPolicy: "human_only"`, `continuationPolicy: "wake_assignee"`, identify the local/remote state without secrets, and require a recheck after the answer. Do not create repeated comments or cards on later heartbeats.
6. Emit concise state-transition telemetry only when the synchronization disposition changes. Document why this shared-workspace guard deliberately fails closed while preserving existing autonomous lifecycles.

**TDD requirements:**
1. Start with parameterized red tests for every observation/disposition pair, including dirty/default, clean/non-default, clean-behind, diverged, missing default ref, remote failure, pull failure, and successful post-pull verification.
2. Use disposable real Git repositories for the fast-forward test. Prove the clean default checkout advances, and prove dirty/non-default checkouts remain byte-for-byte untouched.
3. Add an orchestrator integration regression proving stale sync suppresses new worker/reviewer work and backlog import but does not stop existing Jules or merged-PR reconciliation. Assert the human-only card is reused across heartbeats and an answer alone cannot reopen dispatch.
4. Run each test red before implementation, then focused green tests, the complete orchestrator suite, `pnpm test`, `pnpm build`, adapter reload, and the disposable Paperclip lifecycle E2E without real Jules or GitHub.

**Acceptance criteria:**
- No agent begins new work from a stale or unsafe shared checkout.
- A clean default checkout fast-forwards without depending on host SSH configuration.
- A pending user form is the only human decision path and is visible in Paperclip.
- Existing in-flight provider and PR lifecycles remain live throughout a sync hold.

---
<!-- id: issue-20260913-152810-226-safely-synchronize-a-shared-project-checkout-befor  file: issue-20260913-152810-226-safely-synchronize-a-shared-project-checkout-befor.md -->
