---
title: Implement adapter-neutral manual-default conflict recovery
document_type: execution_plan
base_revision: 927d5f5
status: ready_for_implementation
date: 2026-10-02
---

# Configurable Conflict Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, in small verified steps. Use the current workspace and preserve unrelated user work.

**Goal:** Default conflict recovery to manual, allow any explicitly configured Paperclip agent to resolve it, and continue the existing workflow without new reviews after resolution.

**Architecture:** One adapter-neutral recovery policy/controller serves both conflict entry points. Native task/run/provider dispatch addresses the exact configured agent, and verified repair provenance links the old/current PR heads while preserving existing review decisions. Deterministic Git operations use isolated checkouts; final merge remains user-controlled.

**Tech Stack:** TypeScript, existing Zod, pnpm/Vitest, native Paperclip agent execution, Git, Paperclip 2026.916.0 with PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-10-02-conflict-recovery-policy-design.md`.

## Global constraints

- Manual is the default, including configurations that only set the historical `vibeAgentId`.
- Agent mode requires `conflictRecoveryAgentId`; selection accepts any company agent, regardless of adapter type, role, or managed-fleet membership.
- No Vibe dependency, adapter-type allowlist, role exclusion, or silent agent fallback.
- Conflict resolution preserves original review-card IDs, verdicts, and completed stages. It creates no new reviews and restarts no review ladder.
- Record the head actually reviewed and the head actually repaired separately. Never manufacture a new native verdict or rewrite an old verdict's reviewed SHA.
- A selected remote adapter can use its normal provider lifecycle. Preserve the original implementation session and original PR; a repair task's own session is not a replacement implementation session.
- Manual/human waits have no deadline. Recovery effects and agent admission are durable and single-flight; uncertain outcomes are observed before retry.
- Use isolated checkouts for deterministic Git writes, explicit expected-head leases, bounded subprocesses, and visible failures.
- Final PR merge is performed by the user as a standard merge commit. Actual remote merge, not repair or a gate acknowledgement, completes the source/product.
- Integration tests use real Git and the actual Paperclip 2026.916.0/PostgreSQL host. No mocked database integration, rescue wakes, or observer-driver state repair.
- Keep the existing native review, dependency, and lost-acknowledgement regression coverage.

## Baseline and file map

Baseline: `927d5f5`. Current conflict handlers in `packages/orchestrator/src/server/execute.ts` call `rebasePrBranchLocally` and fall back to Vibe. The current Git helper mutates the project checkout. Existing conflict evidence uses fresh repaired-head reviews; that is historical behaviour and must be changed for this feature.

| Files | Planned responsibility |
| --- | --- |
| `packages/orchestrator/src/server/index.ts`, `test/config.test.ts` | Public policy, selector UI, default/validation. |
| `packages/orchestrator/src/core/conflict-recovery.ts` (new), `test/conflict-recovery.test.ts` (new) | Shared adapter-neutral selection, durable attempt, dispatch, and observation. |
| `packages/orchestrator/src/server/execute.ts`, `src/core/paperclip-http.ts` | Wire both conflict handlers to normal native task/run dispatch. |
| `packages/orchestrator/src/core/local-rebase.ts`, `test/local-rebase.test.ts`, `test/local-rebase-real-git.test.ts` (new) | Isolate deterministic Git operations and prove real repository behaviour. |
| `packages/orchestrator/src/core/conflict-review-continuity.ts` (new), `test/conflict-review-continuity.test.ts` (new) | Verify repair linkage while preserving original review authority/progress. |
| `packages/orchestrator/src/core/review-pipeline.ts`, `src/core/review-epoch.ts`, `src/core/pr-review-child.ts`, `src/core/jules-monitor-state.ts` | Consume continuity at existing head/run checks without creating replacement reviews. |
| `packages/orchestrator/test/contract/jules-server-restart.mjs`, `chain-github-fixture.mjs` | Real conflict/manual/user merge/dependency lanes. |
| `packages/orchestrator/test/contract/conflict-repair-agent.mjs` (new) | Adapter-neutral repair fixture; actual selected-agent credentials and native run ownership. |
| `.github/workflows/paperclip-ci.yml`, `packages/orchestrator/README.md` | Mandatory corrected coverage, configuration/migration docs. |

Use existing provider execution modules when the configured adapter needs repair-assignment routing; inspect that normal lifecycle before editing it. No changes are planned under `packages/vibe`.

## Execution discipline

For each task: write the meaningful failing test, run it, implement the smallest change, run passing tests/build, then commit the verified change. Before changing a core symbol, run `./scripts/adkw doctor` and `./scripts/adkw blast-radius <SymbolName>` and inspect its outline. Scaffold any backlog issue with `./scripts/adkw new-issue --title "Adapter-neutral configurable conflict recovery"`.

Capture commands with `./scripts/adk-run-captured`; use pnpm workspace commands. Run normal commit hooks with resource bounds:

```bash
./scripts/adk-run-captured --timeout 600 -- env npm_config_workspace_concurrency=1 VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 git commit -m "feat(orchestrator): configure adapter-neutral conflict recovery"
```

Stage only the task's changed files. Verified follow-up fixes can be absorbed using the repository's `git absorb --and-rebase` convention.

---

### Task 1: Add manual-default configuration and exact agent selection

**Files:** `src/server/index.ts`, `src/server/execute.ts`, new `src/core/conflict-recovery.ts`, `test/config.test.ts`, new `test/conflict-recovery.test.ts`, under `packages/orchestrator`.

**Interface:**

```ts
type ConflictRecoveryPolicy =
  | { readonly mode: "manual" }
  | { readonly mode: "git_only" }
  | { readonly mode: "agent"; readonly agentId: string };
function normalizeConflictRecoveryPolicy(raw: unknown): ConflictRecoveryPolicy;
function selectConflictRecoveryAgent(
  companyId: string, agentId: string, agents: readonly {
    readonly id: string; readonly companyId: string; readonly adapterType: string;
  }[],
): { readonly id: string; readonly companyId: string; readonly adapterType: string };
```

- [ ] **Write failing tests** for missing mode, explicit manual, agent ID without opt-in, absent ID in agent mode, invalid modes/IDs, exact selection, foreign company, and two available agents where only the configured one may be chosen:

```ts
expect(normalizeConflictRecoveryPolicy({})).toEqual({ mode: "manual" });
expect(normalizeConflictRecoveryPolicy({ conflictRecoveryAgentId: "chosen" }))
  .toEqual({ mode: "manual" });
expect(() => normalizeConflictRecoveryPolicy({ conflictRecoveryMode: "agent" })).toThrow();
for (const adapterType of ["codex_local", "antigravity", "jules", "process"]) {
  expect(selectConflictRecoveryAgent("company", "chosen", [
    { id: "other", companyId: "company", adapterType: "process" },
    { id: "chosen", companyId: "company", adapterType },
  ]).id).toBe("chosen");
}
```

- [ ] **Run red:** `pnpm --filter @pilleo/paperclip-orchestrator-adapter exec vitest run test/config.test.ts test/conflict-recovery.test.ts`.
- [ ] **Implement normalization and exact company-agent selection**, sharing validation between schema/runtime. Add mode select/manual default and the configurable agent ID field. Do not call managed-fleet fallback or inspect adapter/role to exclude an agent.
- [ ] **Run green and build:** repeat targeted tests; `pnpm --filter @pilleo/paperclip-orchestrator-adapter build`.
- [ ] **Commit:** `feat(orchestrator): configure adapter-neutral conflict recovery`.

### Task 2: Route conflict repair through normal native agent execution

**Files:** `src/core/conflict-recovery.ts`, `src/server/execute.ts`, `src/core/paperclip-http.ts`, `test/conflict-recovery.test.ts`, new `test/execute-conflict-recovery.test.ts`, new `test/contract/conflict-repair-agent.mjs`, under `packages/orchestrator`.

**Assignment:**

```ts
interface ConflictRepairAssignment {
  readonly attemptId: string;
  readonly agentId: string;
  readonly companyId: string;
  readonly projectId: string;
  readonly sourceIssueId: string;
  readonly productId: string;
  readonly prUrl: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly expectedHeadSha: string;
  readonly expectedBaseSha: string;
}
```

- [ ] **Write failing tests** for default manual causing zero Git/agent effects, git-only causing zero AI effects, exact configured-agent dispatch in both conflict branches, unmanaged/remote agent acceptance, busy/paused waits, and duplicate ticks/restart/lost admission acknowledgements creating one repair task only.
- [ ] **Run red:** `pnpm --filter @pilleo/paperclip-orchestrator-adapter exec vitest run test/conflict-recovery.test.ts test/execute-conflict-recovery.test.ts`.
- [ ] **Implement the shared controller using native task/run dispatch.** Persist attempt/task/run identity before effects and reconcile readback. Use an ordinary repair task addressed to the configured agent, with the existing project/provider execution context and the assignment above. Instruction: “Resolve the conflicts on this existing PR branch, preserve both sides' intended changes, run the task's verification, and report/publish the resulting head. Do not create a replacement PR.”
- [ ] **Support local and remote routes through normal adapter lifecycles.** Pass repository/branch/PR identity to a remote provider and per-run workspace identity to a local provider. Preserve configured model, credentials, provider, and the source implementation identity. Do not inject ACP/Vibe-specific assumptions or PATCH shared agent configuration. A failed native admission/access check returns a visible wait/failure, never another agent.
- [ ] **Run green and real-host dispatch contracts**, proving both an independent local agent and a remote-backed agent receive and execute the same repair assignment with actual run ownership. Record the actual publication actor. Keep observer writes at zero after setup.
- [ ] **Commit:** `feat(orchestrator): dispatch conflict repair to the configured agent`.

### Task 3: Isolate deterministic Git recovery and verify published results

**Files:** `src/core/local-rebase.ts`, `src/core/git-safety.ts`, `src/core/conflict-recovery.ts`, `test/local-rebase.test.ts`, new `test/local-rebase-real-git.test.ts`, under `packages/orchestrator`.

- [ ] **Write failing real-Git tests** for an owned isolated checkout, clean integration, unresolved conflict, expected-head lease refusal, changed base, push response loss, and preservation of project branch/index/staged/unstaged/untracked work. Agent-result tests independently observe the existing PR's new head and resolved mergeability.
- [ ] **Run red:** `pnpm --filter @pilleo/paperclip-orchestrator-adapter exec vitest run test/local-rebase.test.ts test/local-rebase-real-git.test.ts test/conflict-recovery.test.ts`.
- [ ] **Implement isolated deterministic operations**, 30,000 ms command bounds, explicit abort/cleanup errors, and a push bound to the expected original head:

```ts
await exec("git", ["push",
  `--force-with-lease=refs/heads/${headRef}:${expectedHeadSha}`,
  "origin", `${candidateHeadSha}:refs/heads/${headRef}`,
], { cwd: recoveryWorkspace, timeout: 30_000 });
```

Record candidate SHA before push; observe remote refs after uncertain acknowledgement. A head lease is not atomic protection of the base. Re-observe base drift and keep visible unresolved outcomes.
- [ ] **Verify agent-backed publication independently**, through its actual native run/provider result and current remote PR state. Remote providers need not produce a local candidate directory or use orchestrator-owned push. Keep receipts bound to the same source/product/PR and prevent duplicate dispatch/publication on restart.
- [ ] **Run green and build**, retaining real Git semantics in the existing fixture.
- [ ] **Commit:** `fix(orchestrator): isolate Git recovery and reconcile repair results`.

### Task 4: Preserve reviews across repair and continue the existing merge gate

**Files:** New `src/core/conflict-review-continuity.ts`, new `test/conflict-review-continuity.test.ts`, `src/core/review-pipeline.ts`, `src/core/review-epoch.ts`, `src/core/pr-review-child.ts`, `src/core/jules-monitor-state.ts`, `src/server/execute.ts`, existing review/handoff tests, under `packages/orchestrator`.

**Interface:** `verifyConflictReviewContinuity` accepts the original review/progress head, the current remote head, and a verified `ConflictResolutionReceipt` from the spec. It returns verified continuity only for that exact PR and linked repair. Existing cards keep their original reviewed SHA; current publication/merge observation uses the resolved SHA.

- [ ] **Write failing tests** with existing answered review cards, a completed or partially completed review ladder, and a verified repair head. Assert original card IDs/verdicts/stage progress remain unchanged and no conflict-triggered review dispatch occurs:

```ts
expect(after.reviewCardIds).toEqual(before.reviewCardIds);
expect(after.reviewVerdicts).toEqual(before.reviewVerdicts);
expect(after.completedReviewStages).toEqual(before.completedReviewStages);
expect(newReviewerRuns).toHaveLength(0);
expect(after.reviewedHeadSha).toBe(before.reviewedHeadSha);
expect(after.currentHeadSha).toBe(resolution.resolvedHeadSha);
```

Use the existing pipeline/child test fixtures to construct `before`, `after`, and actual observed reviewer-run counts. Add rejection tests for an unrelated PR/head, forged repair receipt, conflicting/uncertain repair outcome, and unlinked subsequent code revision.
- [ ] **Run red:** `pnpm --filter @pilleo/paperclip-orchestrator-adapter exec vitest run test/conflict-review-continuity.test.ts test/review-pipeline.test.ts test/pr-review-child.test.ts test/jules-monitor-state.test.ts`.
- [ ] **Implement verified review continuity at head/run checks.** Preserve native verdict evidence and completed stages; link the old and resolved heads through separate repair provenance. Manual, deterministic, and configured-agent repair all use this rule. Do not create replacement review cards, restart the ladder, or pretend the repair head was newly reviewed.
- [ ] **Continue the existing user merge gate** with visible current-head/repair provenance. Remove the legacy `EXECUTE_MERGE` subprocess/direct done PATCH so approval waits for the user's actual merge. Existing remote-merge reconciliation remains responsible for source/product completion and dependency release.
- [ ] **Run green**, `pnpm typecheck:invariants`, and the affected package build. Verify unrelated ordinary code revisions retain their existing review handling.
- [ ] **Commit:** `fix(orchestrator): preserve review progress after conflict resolution`.

### Task 5: Qualify the corrected workflow and document configuration

**Files:** `packages/orchestrator/test/contract/jules-server-restart.mjs`, `conflict-repair-agent.mjs`, `chain-github-fixture.mjs`, `.github/workflows/paperclip-ci.yml`, `packages/orchestrator/README.md`, new `docs/superpowers/evidence/2026-10-02-configurable-conflict-recovery.md`.

- [ ] **Add failing receipt assertions** for default/manual waits across ticks/restart, exact selection across local/remote adapters, independent-agent selection, original PR preservation, no duplicate repair, original review cards/verdicts preserved, and zero extra conflict-triggered reviewer runs.
- [ ] **Run the failing focused fixture/receipt tests**, then adjust the existing daemon lane. Replace its Vibe-specific setup with the adapter-neutral repair fixture and explicit selector. Old evidence remains historical; the corrected lane must demonstrate review continuity.
- [ ] **Run real-daemon positives:** manual external resolution; git-only clean/conflicting cases; selected independent local-agent repair; selected remote-agent repair. Complete agent repair through the existing pending user gate, restart, explicit standard user merge, normal source/product completion, and separately approved dependent release.
- [ ] **Add compiled negative controls** for manual-policy bypass and restarting review after repair. Grade them from actual unintended recovery effects or additional native review cards/runs, not generic timeouts. Restore/recompile the private package and complete each positive workflow. Never mutate the installed host or repository source to manufacture results.
- [ ] **Document exact settings and migration:** manual default, any company agent selectable, ID alone does not enable AI, no extra reviews after conflict resolution, and final merge remains user-controlled. No Vibe instructions or managed-worker requirements.
- [ ] **Run final checks:** `pnpm build`, `pnpm test`, `pnpm typecheck:invariants`, relevant Node fixture/contract tests, `git diff --check`, and `./scripts/adkw check-backlog`. Its ten recorded historical frontmatter errors must not increase. Commit verified coverage/docs with normal bounded hooks.
- [ ] **Use the existing journaled drain/reload for authorized live deployment**, verify loaded affected dist entries and one succeeded reconciliation, then qualify one live card before resuming user-approved campaign work.

## Delivery order

Start with configuration and adapter-neutral dispatch, then verify repair publication, preserve review continuity, and qualify the complete workflow. The acceptance criteria are the user's actual requirements: **manual by default; any configured agent; no re-review after conflict resolution**.
