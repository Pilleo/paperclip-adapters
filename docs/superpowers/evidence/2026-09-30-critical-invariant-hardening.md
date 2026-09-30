# Critical invariant hardening: small TDD steps

## Scope and workflow

The user requested strict types and exhaustive decision boundaries before further stress testing, implemented in tiny TDD-only steps with a commit after each step. This batch hardens mutation replay, native review provenance, PR handoff and merge completion. It does not replace the entire persisted Jules session representation in one change.

Each implementation step was preceded by an observed failing runtime test and, where its signature changed, failing negative compile-time tests. Normal pre-commit workspace build/test checks passed before each successful commit. Two attempts exposed unrelated CLI subprocess timeouts under parallel load; checks were rerun with serialized workspace scheduling and bounded Vitest workers, without changing assertions, increasing test deadlines or bypassing hooks.

## Independent implementation commits

| Commit | Locked rule |
| --- | --- |
| `694ae58` | Generic native-card retry cannot replay uncertain provider messages, approvals, revisions or unknown legacy effects. |
| `8ae6ab0` | Retry requires an effect-bound authorization from native-card absence reconciliation; proofless calls and forged runtime objects are rejected. |
| `68a50be` | A confirmed receipt cannot be overwritten; repeated identical confirmation remains idempotent. |
| `023d6f4` | Terminal handoff carries immutable validated issue/session/PR/head/producer/completion-run identity; bare labels and changed-head copies cannot authorize review. |
| `5295870` | Parent review projection accepts only observations attested by the native child/card/run reader; copied or foreign-head observations are rejected. |
| `f2b7f12` | Merged observations require a merge timestamp; malformed runtime timestamps defer completion. Open observations cannot declare completed merge time. |
| `e923917` | A `done` patch requires an issued merge authorization bound to the same issue. Invalid PR identity, another registered PR, forged/copy evidence and wrong-issue reuse fail closed. |
| `ac1c918` | Native retry authorization is nominal and non-copyable; an object-spread with another effect ID cannot grant retry. |
| `bb3c12c` | Bootstrap and reviewer responses must match the card's exact source/resolver run IDs before verdict attestation. |
| `1020335` | A durable effect ID cannot be repurposed for a different operation kind. |
| `e92acef` | Approval progression is exhaustively limited to `IN_PROGRESS` or `COMPLETED`; unknown, failed or still-pending states cannot confirm an interrupted approval. |
| `ce17e6b` | An older completed producer cannot override a later live/unknown provider observation. A newer observation requires its own exact-head terminal proof. |

## Enforcement boundaries

- Native retry, terminal PR handoff, native child verdict and merged-task authorization use nominal module-issued types. Their objects are frozen, and runtime issuance registries reject plain JSON, casts and copied objects. Validated capabilities are ephemeral: a restart or transport read must revalidate the underlying facts rather than deserialize an execution grant.
- Durable journals persist evidence and effect identity, not ephemeral authorization objects. Confirmed effects remain monotonic across checkpoint merging; an uncertain provider effect remains an observation/reconciliation obligation.
- Native verdict proofs bind the versioned company/parent/PR/head/stage/reviewer/bootstrap identity and exact child/card/reviewer run. Free-text review conclusions cannot construct them.
- Handoff proofs retain the original producer identity and the actual completion-run identity separately. Legacy producer metadata is not rewritten. Live execution and later unverified observations preserve ownership.
- Merge decisions and command construction are separate: only validated merged observations issue authorization, and the `done` command checks its exact issue binding before construction. Existing execution-blocker checks still precede terminalization and cancellation effects.

## Compile-time verification

`pnpm typecheck:invariants` covers negative type tests for bare retry calls, proofless retry results, copied authorization, unrecognized approval progression, bare handoff labels, changed-head handoff copies, invented native verdict observations, contradictory merged/open timestamps, invented completion decisions and unbacked `done` patches. Runtime tests separately exercise malformed objects and scope mismatch; compile-time checks alone cannot validate remote facts.

Strict campaign script compilation remains under `pnpm --filter @pilleo/paperclip-orchestrator-adapter exec tsc -p tsconfig.stress.json`.

## Real-host E2E qualification

All contracts use unmodified installed Paperclip `2026.916.0` and real isolated PostgreSQL:

1. `stable_child_jules_v4_revise_message_lost --require-safe`: one original-session revision POST with a lost response is reconciled through observation, without provider replay. Passed after the final approval-state narrowing.
2. `PAPERCLIP_TEST_TERMINAL_HANDOFF_WAIT=1 ... --scenario=stable_child_executor_pr_board_reject --require-safe`: bounded handoff wait, native source/reviewer identity proof, typed rejection projection and one original-session feedback delivery. Passed with nominal retry/verdict/merge boundaries.
3. `PAPERCLIP_TEST_LEGACY_PRODUCER=1 ... --scenario=stable_child_chain_abc_later_jules_run --require-safe`: legacy original producer plus genuinely held later worker; ownership remains intact until the later verified completion and the full A→B→C native flow succeeds.
4. `stable_child_chain_abc_recover_auto_blocker --require-safe`: a GitHub merge does not erase a failed-run hold; exact typed recovery permits subsequent verified terminalization and dependent progression.
5. `stable_child_chain_abc_later_jules_run --require-safe`: passed after the final newest-observation fence, including an already-completed original producer and later genuine active execution.

Relevant persisted logs: `run-984d6037a9e9`, `run-fb5221c48275`, `run-94a2ae27960c`, `run-79f14f5103b3`, `run-bd3e1fa65c17`, and `run-b4f112d7ec73` in the bounded command-output store. Each returned exit code 0.

## What remains a runtime contract

These changes prohibit specific invalid local states and commands; they do not make remote observations infallible or make Paperclip's non-conditional ownership PATCH atomic. Fresh host reads, runtime schemas, journals and controlled-concurrency host contracts remain required. The broader persisted session phase model and recovery observation normalization can be tightened in later small steps without weakening these command/provenance contracts.

No live card, provider message, GitHub merge or fresh stress-task creation was used to validate this hardening batch. External packages were rebuilt and reloaded after six-company `/live-runs` returned empty; startup logs loaded orchestrator and Jules `dist/index.js`. Automatic post-reload recovery heartbeat `76dae726-7ffd-4d51-afe4-b24dbc6dc81a` succeeded at `2026-09-30T08:44:20Z` with no error.

The operational read/restart gap remains visible: unscoped scheduler heartbeat `2b622b36-f17b-41aa-ad3d-d0df68b48e6b` started at `08:32:27Z` after the idle observation and before shutdown, then the host recorded `process_lost` at `08:37:39Z` and dispatched the succeeding recovery heartbeat. Do not describe this as an atomic idle restart. Future reload tooling must qualify/use the installed host's native task-drain admission barrier before checking quiescence, rather than relying on another idle sample. No type or transition invariant was relaxed to hide the operational race.
