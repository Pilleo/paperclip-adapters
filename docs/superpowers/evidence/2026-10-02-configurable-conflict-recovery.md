# Adapter-neutral configurable conflict recovery qualification

## Delivered behaviour

- Missing `conflictRecoveryMode` defaults to manual. A stored resolver ID alone never enables AI.
- `agent` selects the exact company agent ID without adapter, role, or managed-fleet restrictions. Independent process and Jules agents were exercised through their normal native/provider lifecycle.
- `git_only` uses an owned isolated clone and an explicit expected-head push lease. Real Git regressions cover dirty project/index preservation, actual conflict, stale head, and remotely accepted push with lost acknowledgement.
- Repair updates the original product and records the actual repair task/run and resulting head. Native review cards, verdicts, original reviewed SHA and completed progression remain intact; conflict repair does not trigger re-review.
- Approved final merge cards wait for actual user standard merge. Normal reconciliation completes source/product and releases a separately approved dependent.
- Native task/card admission and publication uncertainty are observed, not blindly replayed. Paperclip mutation transport no longer retries an uncertain mutation.
- Confirmed conflict is retained when the additional immutable-ref lookup fails. Automatic effects hold for unavailable or changed head/base refs.
- Verified external resolution settles its obsolete operator conflict card with an explicit superseded note; original review verdicts are untouched.

## Real-daemon evidence

All cases use installed Paperclip **2026.916.0**, real embedded PostgreSQL, built adapter dist entries, real bare Git transport and scheduled orchestrator heartbeats. Reviewer decisions pass through the authenticated native MCP bridge. Provider/repair/user actors perform their normal operations; the observation driver records zero writes after start.

| Case | Result | Captured run |
| --- | --- | --- |
| Initial independent process repair, preserved reviews and user merge | passed, 171.227s | `run-4a3aefd5c836` |
| Initial independent remote Jules repair on original PR branch | passed, 172.877s | `run-95803fa4b10e` |
| Missing-config manual wait, three ticks, restart, external resolution, retained merge gate and A→B release | passed, 247.237s | `run-25cf652cd939` |
| Git-only disjoint base advance with clean isolated integration, retained reviews/gate and A→B release | passed, 192.527s | `run-efa941473bc8` |
| Git-only overlapping conflict held for manual resolution, no AI, restart/gate/A→B release | passed, 253.780s | `run-a097884d0ff3` |
| Remote Jules repair, retained merge gate across restart, actual user merge and A→B release | passed, 193.183s | `run-75f25aba56ad` |
| Final missing-config manual workflow with resolved action-card cleanup | passed, 250.117s | `run-12e5eb893a40` |

The full cases assert the exact original two review-card IDs, zero additional reviewer starts after publication, original implementation session retained, current resolved product head, pending merge card retained across restart, approved gate not completing/merging the source, two-parent user merge, source/product completion by scheduling, B unassigned until its own native start approval, and a distinct B provider session.

The git-only clean fixture observes published heads from its real bare remote; it does not fabricate a successful integration in Paperclip. Semantic checks execute the published JavaScript exports independently of agent prose.

## Effective negative controls

`pnpm exec node scripts/contract/autonomous-conflict-mutation.mjs` passed the complete two-control qualification in **710.714s**, captured as `run-cb82f1f99d52`.

1. **Manual policy bypass:** a compiled private copy skips the native manual wait and exposes a merge gate while the conflict remains unresolved. The actual daemon fails at `manual_conflict_wait_bypassed_into_merge_gate`.
2. **Erroneous review restart:** a compiled private copy discards recorded review continuity. The actual daemon creates additional native review cards; the lane fails at `conflict repair must not create additional native review cards`.

Each private package is restored/recompiled and then completes the full positive workflow, including pending-gate restart, actual user standard merge and independently user-approved dependent release. Repository source bytes remain unchanged by the mutation runner. Private receipts/logs: `/tmp/paperclip-conflict-mutations-9vJ3Sj/`.

These are behavioural defects with successful compilation and exact package-loader checks. Setup failures, generic timeouts, and compilation errors are not counted as regression detection.

## API contracts established during qualification

- `/issues/:id/runs` uses **`runId`** and **`contextIssueId`**, with summarized `resultJson`; hydrate the exact product `createdByRunId` through `/heartbeat-runs/:id` before accepting completion.
- Native product creation requires `provider: "github"`. The independent process actor registers output on its own repair task using its actual run credentials.
- Antigravity fixtures require `serverPath`, `nativeReview: true`, and the native-review MCP arguments; using `serverCommand` does not launch that fixture correctly.
- Adapter dist-load logging occurs at execution, so the exact loader witness is checked after initial native review execution and before grading recovery defects.
- Disposable embedded PostgreSQL uses port 54329 by default. These real-daemon lanes run sequentially; parallel starts collide. Unit/Git tests can run independently.

## Scope

This qualifies orchestration, native protocol, persistence, Git fidelity, review continuity, user waits and dependency release. The local/remote model providers are deterministic external actors; actual live model-quality qualification is separate. No main-service restart or live campaign start was performed in this implementation session.
