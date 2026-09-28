# A→B→C Regression Gates and Typed Lifecycle Implementation Plan

> **For agentic workers:** Execute the tasks in order, inline on `master`. Each task is a separate red/green/verify/commit cycle; do not use a worktree or send GitHub merges.

**Goal:** Make the complete disposable A→B→C Jules/native-review/external-merge flow a reproducible regression barrier before refactoring the state and effect boundaries into small, exhaustive types.

**Architecture:** Retain the existing installed-host native contract harness and real-project canary; add completion-enforcing gates and a stateful provider/Git fixture that exercises the real adapters, authenticated review workers, PostgreSQL, and externally applied merge commits. Keep live-provider qualification separate and human-gated. Extract pure transition functions only after characterization and deterministic integration gates protect their observable behavior.

**Tech Stack:** Node 24, pnpm, TypeScript/Vitest, Paperclip `2026.916.0`, embedded real PostgreSQL, authenticated host process-adapter workers, local Git repositories, Jules HTTP fixture, GitHub CLI fixture.

**Spec:** Approved user requirements in the 2026-09-28 conversation; existing behavior and live A/B/C chronology in `docs/superpowers/evidence/2026-09-27-jules-plan-approval.md`.

## Global constraints

- Never run `gh pr merge` or submit a GitHub review; only the user may merge live PRs. The deterministic test's *local* merge simulator is an external actor, never adapter code.
- Use native addressed typed verdicts with run attribution. Do not synthesize a review in issue comments or board-level prose.
- Pin the installed host to `2026.916.0`; qualify other versions separately. Real database integration tests must use actual PostgreSQL or SQLite, not mocked DB calls.
- Preserve historical v3 checkpoints and v1 child identities; decode versions at boundaries rather than rewriting persisted data during unrelated refactors.
- Uncertain provider effects are not safe to replay merely because a response was lost. No silent error swallowing, forced board completion, or mid-test repair PATCHes.
- Start with real observed failures, run a failing regression before behavior changes, then focused tests, installed-host contract, typecheck/build, and completion gate.
- `tsconfig.base.json` **already** enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `useUnknownInCatchVariables`; do not claim these are missing or blanket-toggle them.
- Before core symbol edits run `./scripts/adkw doctor` and `./scripts/adkw blast-radius <SymbolName>`; outline before full source views. Check backlog before completion; 10 existing missing-frontmatter errors were observed at plan creation.

## Invariant-to-gate map

| Invariant | Fast tests | Real host / completion proof |
| --- | --- | --- |
| B waits for verified A merge; C waits for B | `real-e2e-canary-progress.test.ts`, `dependency-gate.test.ts` | Full-chain event timeline, merge SHA ancestry, final files |
| Session identity preserved; effects not replayed after uncertain acceptance | Jules lifecycle/effect-journal/checkpoint tests | Stateful Jules fixture: accept-and-drop then persistent restart, mutation count |
| Revision-/head-/reviewer-/run-bound typed verdicts | `pr-review-child.test.ts`, plan/native-review tests | Host-created child and addressed reviewer JWT verdict evidence |
| One pending card per stage and one active addressed run | PR child/recovery tests | Host runs/cards plus fault-injected reviewer runs |
| Changed head invalidates previous approvals | `review-interaction-state.test.ts` | Strong-review stale-head mutation in chain fixture |
| External merge alone advances issue/product and releases dependency | `execute-native-pr-approval.test.ts` | Local external merge actor, two parents, no adapter merge, pending approval reconciliation |
| Crash cannot erase acknowledged progress | Jules checkpoint and store tests | Stop/relaunch **actual server** against retained DB and session store |
| Terminal status and actionable recovery are coherent | Snapshot tests, recovery-state tests | External merge with historical failed Jules run; assert actionable hold cleared or explicitly terminalized |
| Worker/lease/resource ownership and cleanup | Focused cancellation/lease tests | Competing claims and stopped-worker restart; no leaked worker/DB process |

Safety fails on wrong identity, duplicate effects, premature execution, invalid verdict, or illegal merge. Progress fails on bounded timeout, including snapshots that are merely `await_a`, `await_b`, or `await_c`.

## File responsibilities

- `.github/workflows/paperclip-ci.yml`: supported-version canary and version-pinned native positive contracts; upload sanitized reports even on failure.
- `packages/orchestrator/scripts/e2e-jules-recovery.ts`: older board-created parent-card canary; its `local_path` workspace needs valid repository metadata on the supported host, then route expectations must be requalified against the current v2 child protocol rather than weakening assertions.
- `packages/orchestrator/scripts/e2e-real-project-canary-verify.ts`: preserve read-only observation, expose an explicit terminal acceptance mode and awaiting-human status; never wake/merge.
- `packages/orchestrator/src/core/real-e2e-canary-progress.ts`: pure snapshot/transition validation, including terminal and historical-blocker semantics. Do not equate `done` with proved GitHub merge.
- `packages/orchestrator/test/real-e2e-canary-progress.test.ts`: data-driven invalid, awaiting, and complete cases.
- `packages/orchestrator/test/contract/native-plan-concurrency.mjs`: reuse version-pinned host admission, authenticated routes and workers; extend only where host-level behavior belongs.
- `packages/orchestrator/test/contract/*-chain*.mjs`: focused full-chain scenario coordinator, persisted provider/Git fixtures, evidence assertions. Avoid expanding the current 800-line harness with unrelated responsibilities.
- `packages/jules/test/*` and `packages/orchestrator/test/*`: fast pure boundary and transition tests, plus compile-time negative type tests.
- `docs/superpowers/evidence/*`: sanitized evidence and exact commands; no keys, bearer tokens, or full private checkpoints.

## Task 1 — completion-safe canary verification and supported host alignment

- [ ] Add a **failing** test that calls the real canary verification CLI with isolated loopback fixture snapshots for `await_a` and expects nonzero in terminal-acceptance mode; preserve snapshot mode's current successful observation and forbid writes.
- [ ] Add a failing test for all-three-done Paperclip snapshots where GitHub has not verified merge heads/parents; terminal acceptance must not pass merely because work products say `merged`.
- [ ] Implement explicit result handling: `awaiting_human`, `awaiting_progress`, `invalid`, `passed`, with bounded `--wait-for-completion` deadline and terminal exit codes. Keep default read-only snapshot behavior compatible.
- [ ] Pin CI Paperclip install to `2026.916.0`; test the CI/YAML host pin and add a Node 24 supported-host step invoking selected positive `--require-safe` scenarios (`stable_child_jules_v4_executor`, `stable_child_executor_pr_board`, `stable_child_executor_pr_probe`). Do not include the deliberately unsafe negative handback scenarios as a green gate. Save/upload the contract JSON reports even when a scenario fails.
- [ ] Run focused unit tests, selected installed-host scenarios, `pnpm build`, and `pnpm test`; commit this independently useful gate slice.

## Task 2 — deterministic baseline full chain

- [ ] Add a failing host-contract scenario requiring A→B→C terminal issue/product convergence, exact predecessor merge gate, native typed plan/PR verdicts and unique provider sessions/products.
- [ ] Extend the existing host-contract infrastructure with stateful Jules responses and a local Git repo plus fixture `gh` that observes PR heads and merged commits. Seed only the initial company/project/agents/issues; no repair PATCH after start.
- [ ] Add a distinct external merger test actor that performs ordinary two-parent local Git merges after valid head-bound typed approvals, then exposes authoritative merged state to the CLI fixture. Assert adapters never invoke a merge command.
- [ ] Record a bounded chronological event log and verify final repository files, head ancestry, no duplicate cards/effects/products, and A/B/C dependency release. Run through `--require-safe`, integrate it into CI, and commit.

## Task 3 — genuine retained-storage restart

- [ ] Add a failing variant of Task 2 that kills the disposable Paperclip process between confirmed approval and PR registration; ensure no live reviewer run is killed without recording its outcome.
- [ ] Relaunch the actual host with the same PostgreSQL data, `PAPERCLIP_HOME`, and Jules session-store directory. Do not replace a restart with two executor calls in one process.
- [ ] Verify same session and native identities, exactly one approved provider effect, bounded completion, and clean process/DB cleanup; commit.

## Task 4 — uncertain accepted provider effect

- [ ] Add a failing scenario where the stateful Jules fixture accepts a mutation, persists the resulting provider state, then drops the response before the adapter records its receipt.
- [ ] Restart at that boundary; the adapter must reconcile authoritative provider evidence before any second mutation. Assert one mutation and original session, card, PR and work product identity.
- [ ] Exercise create/approve/message as separately identified subcases; fail closed for missing or ambiguous evidence. Commit after the baseline full-chain gate remains green.

## Task 5 — external merge and historical recovery projection

- [ ] Add failing variants for pending native merge approval during external merge and C-shaped terminal Jules failure with a `legacy_execution_requires_reconciliation` blocker.
- [ ] Verify normal external merge plus the orchestrator's real reconciliation makes product `merged`, issue `done`, and dependency eligible. Define and test a non-actionable terminal recovery projection separately from the immutable historical audit. Never clear the blocker by fixture PATCH or blindly replay its old run.
- [ ] Test changed-head re-review and failed-before-verdict reviewer recovery under the same scenario coordinator; commit in separate slices if either alters implementation behavior.

## Task 6 — incremental compiler-enforced refactors (one per commit)

Only start when Tasks 1–5 run green in their appropriate gates. Each bullet starts with a test that would fail for the observed bug or a passing characterization test for a behavior-preserving extraction; compile-time negative fixtures prove impossible values are rejected.

- [ ] **PR observation:** decode `unavailable | confirmed_absent | observed(head, repo, PR)` at the HTTP boundary; prevent failed GitHub lookups or compact issue lists from erasing registered PR evidence.
- [ ] **Review evidence:** construct a validated immutable-head/revision/reviewer/run proof after runtime equality and provenance checks; accept only that proof in merge-eligibility decisions.
- [ ] **Effect state:** introduce one versioned discriminated union `prepared | inFlight | outcomeUnknown | confirmed | failed`, with mandatory receipt on `confirmed`, and pure exhaustive reducer. Keep wire-compatible historical codecs; migrate one effect at a time.
- [ ] **Command boundary:** for the migrated effect have the reducer return typed commands to existing durable effect executors. Check one serialized intent/one receipt or unresolved unknown after crash/replay.
- [ ] **Board projection:** split historical audit from actionable recovery/active stage; confirmed merge cannot coexist with a *current actionable* execution hold. Validate host authority and capabilities before any production PATCH.
- [ ] **Resource ownership:** migrate one timer/lease/worker to explicit acquire/renew/release and cancellation semantics; test stale-owner writes and teardown in real storage.
- [ ] Remove old paths only after old checkpoint fixtures decode and Tasks 1–5 stay green. Never combine persistence-format changes, decision changes, and effect changes in one commit.

## Gate policy

- PRs: workspace unit/type/build + positive supported-host contracts + deterministic full-chain completion and fault cases.
- Scheduled/manual release qualification: opt-in live Jules/reviewers/GitHub, with explicit `awaiting_human` until the user merges. A launch or an intermediate snapshot is not a pass.
- Each gate writes bounded, sanitized JSON: host version, test seed, session/issue/run/card identifiers, event ordering, commands/effect counts, and failure reason. If any gate times out, fail and retain evidence; no silent retry.
