---
title: A→B→C regression gates and typed lifecycle
status: in_progress
document_type: execution_plan
base_revision: 5d64409
---

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

- [x] Add a **failing** test that calls the real canary verification CLI with isolated loopback fixture snapshots for `await_a` and expects nonzero in terminal-acceptance mode; preserve snapshot mode's current successful observation and forbid writes.
- [x] Add a failing test for all-three-done Paperclip snapshots where GitHub has not verified merge heads/parents; terminal acceptance must not pass merely because work products say `merged`.
- [ ] Implement explicit result handling: `awaiting_human`, `awaiting_progress`, `invalid`, `passed`, with bounded `--wait-for-completion` deadline and terminal exit codes. Keep default read-only snapshot behavior compatible.
- [x] Pin CI Paperclip install to `2026.916.0`; test the CI/YAML host pin and add a Node 24 supported-host step invoking selected positive `--require-safe` scenarios (`stable_child_jules_v4_executor`, `stable_child_executor_pr_board`, `stable_child_executor_pr_probe`). Do not include the deliberately unsafe negative handback scenarios as a green gate. Save/upload the contract JSON reports even when a scenario fails.
- [x] Run focused unit tests, selected installed-host scenarios, `pnpm build`, and `pnpm test`; commit this independently useful gate slice.

## Task 2 — deterministic baseline full chain

- [x] Add a failing host-contract scenario requiring A→B→C terminal issue/product convergence, exact predecessor merge gate, native typed plan/PR verdicts and unique provider sessions/products.
- [x] Extend the existing host-contract infrastructure with stateful Jules responses and a local Git repo plus fixture `gh` that observes PR heads and merged commits. Seed only the initial company/project/agents/issues; no repair PATCH after start.
- [x] Add a distinct external merger test actor that performs ordinary two-parent local Git merges after valid head-bound typed approvals, then exposes authoritative merged state to the CLI fixture. Assert adapters never invoke a merge command.
- [x] Record a bounded chronological event log and verify final repository files, head ancestry, no duplicate cards/effects/products, and A/B/C dependency release. Run through `--require-safe`, integrate it into CI, and commit.

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

- [ ] **PR observation:** first extraction completed for `remote_open | registered_after_unavailable | registered_outside_window | unavailable | not_in_window` at the bounded list boundary. A separate authoritative targeted-view/REST decoder is still needed before `confirmed_absent` can be represented safely; protect registered PR evidence against failed GitHub lookups and compact issue lists.
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

## Execution evidence and remaining barrier (2026-09-28)

The dated bullets below record intermediate gates. The current full-chain
result and remaining fault injections follow them.

- Commits `40d94ac`, `dd3d83c`, `b1b989d`, `b4654ef`, `c13930a`, `45ba9f0`, `8d75258`, and `950ef56` implement independent unit/package, historical safety, and native contract jobs. The contract runner requires fresh per-scenario reports, the exact scenario/host version, an observed/pass result and exit zero; launch errors, malformed/missing/stale reports and timeouts fail. CI executes the runner's Node tests.
- Four positive `2026.916.0` real-PostgreSQL native contracts passed locally with `--require-safe`, including one board-authorized typed withdrawal of an idle historical parent PR card followed by Luna and strong child-scoped verdicts. These independent scenarios are **not** a three-task A→B→C acceptance test.
- A disposable real Paperclip process retained an acknowledged company across stop/restart with the same embedded PostgreSQL data. Controller tests also proved timeout and stubborn worker process-group teardown. This restart has **not** yet exercised a Jules approval receipt, queued reviewer, or PR-registration boundary.
- The older recovery server canary passed on a disposable installed host as a **safety characterization**, reporting `board_disposition_required` with the original pending parent PR and stale plan cards, matching registered head, no active addressed reviewer run and no new Jules provider execution. It does not claim a native review or automatic disposition. The separate typed-withdrawal contract covers positive reviewer continuation. Paperclip `2026.916.0` may reject company DELETE after heartbeat events because of a host FK; on an explicitly marked isolated CI instance only, teardown stops the server process group and removes the entire disposable home instead.
- The read-only A→B→C observer now has a bounded `--wait-for-completion` mode requiring terminal Paperclip convergence, exact registered PR heads and two-parent GitHub merge evidence. It does not synthesize approvals or merge PRs. It still lacks durable run/interaction timeline proof, automatic deterministic provider execution, and a full-chain CI scenario.
- Increment `62be4bf` adds a fifth positive native contract: the actual Jules executor creates its provider session instead of adopting a seeded one, performs the v4 typed plan-review ladder, approves once, and registers its PR at a real disposable Git head. The existing independent board-origin PR-review contract now feeds its real host-attributed Luna/strong verdict cards and source/reviewer run IDs to the local **external test actor** before an ordinary two-parent merge. Local Git fixture tests prove A→B→C ancestry and reject early stale-base merges. These remain complementary single-task host scenarios plus a Git fixture: the three tasks have **not yet** shared one host company, dependency DAG, provider lifecycle, and merge/reconciliation timeline.
- An accepted-but-lost provider-create contract now persists the remote session, drops the POST response, requires the original Jules run to fail closed, resolves the **exact failed run** through the board-authorized typed execution-recovery route using observed completed-effect evidence, and adopts the original session through `GET /sessions`. The continued v4 plan/PR flow proves one create and one approval, with no duplicate provider mutation. This is an isolated single-task fault contract, not process-level Paperclip restart or full-chain acceptance.
- The shared-company native contract now owns one Paperclip project/workspace with a real local Git checkout and authoritative A→B→C blocker edges. It drives actual Jules A creation, typed Luna/strong plan reviews, one approval, and PR registration. The **actual orchestrator** promotes A and dispatches its PR children; actual authenticated Luna/strong verdict and source/reviewer runs authorize an external two-parent merge. A later orchestrator heartbeat marks A `done`, product `merged`, releases B's native `blockedBy`, and leaves C blocked. A managed strong reviewer is required for the v1 child lane; without it the host creates a parent PR card and correctly waits for typed withdrawal. The gate still has **not** run B or C provider/review/merge cycles; no fixture status PATCH completes A.
- **Next red test:** a real-host deterministic A→B→C scenario that cannot finish by manually PATCHing issues, provider checkpoints, PR products, or verdicts after fixture creation. Advance one Jules-owned provider session at a time through authenticated native plan/PR cards and locally simulated external two-parent merges; require the dependency timeline and final repository files. Then inject retained-storage crash and accepted-but-lost provider responses. Only after those gates pass begin the typed transition/effect extractions above.

### Full shared-host baseline (2026-09-29)

`stable_child_chain_abc_complete` now passes against installed Paperclip
`2026.916.0` with real embedded PostgreSQL. It starts with one project and
three real dependency-linked issues, uses distinct Jules provider sessions
and addressed plan/PR verdicts for A, B and C, accepts task-start approvals
through the board route only after the predecessor's merge, and lets only the
external test actor make ordinary two-parent local Git merges. Real
orchestrator heartbeats reconcile all three issues and products terminally;
the test reads final file contents and rejects a terminal issue with an
actionable execution blocker. The fixture needed an active `local-board`
membership to keep host-generated delegated run JWTs valid. Its bounded
status-only comment follow-up never acts as review evidence or a provider
mutation. **This is the completion baseline**; it is not a server-process
restart during the chain, a simultaneous-writer race, or a live-provider
qualification. Those remain as Tasks 3–5, before Task 6 type refactoring.

`stable_child_chain_abc_lost_b_create` also completes the entire chain when
the provider accepts B's create request and loses its reply. The original B
run fails closed; the board's **typed execution reconciliation** records
completed remote creation on that exact run. A successor reads `/sessions`
and adopts the original B session before approvals and PR delivery. All
three issues/products still converge to merged/done, with exactly one
create and approval per task. The fixture's local-trusted board actor must
be an active company member or its delegated Jules JWT fails closed with
`RESPONSIBLE_USER_UNAVAILABLE`. A `missing_issue_comment` status-only run
may post a bounded status note, but never a structured verdict or provider
mutation. This is a worker-failure test; the real control-plane restart
mid-chain and stale historical terminal blocker remain unverified.

The disposable real-server restart contract additionally persists an
exact-head **pending native reviewer card** with the original issue and
company in embedded PostgreSQL; it checks the all-company live-run gate
before restart, then reads the same card/key/reviewer/issue back from the
new Paperclip process. This is a genuine control-plane process restart,
but does not yet cross the Jules approve-plan-to-PR-registration boundary.

`jules-server-restart.mjs` now crosses that specific boundary on the actual
installed host. Jules itself creates the remote session, two addressed native
plan cards receive distinct authenticated reviewer-run approvals, and the
single provider approval is durably confirmed while PR output remains
withheld. The test waits for fleet idle, restarts Paperclip with its original
embedded PostgreSQL data and Jules session store, verifies both startups
loaded the built Jules package and the same session/approval/cards survived,
then releases one PR output from the **original** provider session and checks
exactly one registered head. This is a genuine process restart; the complete
three-task chain is still exercised by the separate in-process-host contracts.
The formerly failing `missing_issue_comment` status-only host run is now
fenced at the Jules executor boundary by an authoritative run/issue/agent
check and a single run-scoped execution-status comment. It cannot spend a
provider mutation, alter a deliverable, or stand in for a typed verdict.

`stable_child_chain_abc_lost_b_approval` now exercises the other high-value
ambiguous provider boundary **inside the complete shared-company chain**.
The B approval effect has a durable started journal entry; the provider
accepts that exact approval, records `planApproved` with a post-attempt
timestamp, then drops the HTTP reply. Jules must verify same-session
activities and register B's PR without a second `approvePlan`; all three
issues/products still converge. An initially backdated fixture activity
correctly failed closed as `unverified_progress`, demonstrating that a
historical approval cannot authorize an uncertain current effect. A restart
*inside* an uncertain provider mutation and C's historical terminal
failed-run blocker remain unverified.

`stable_child_jules_v4_revise_message_lost` now covers accepted-but-lost
`sendMessage` on an addressed plan rejection in the **original** Jules
session. The provider persists a userMessaged echo and a second plan
activity but drops the HTTP reply. Jules reads that session's activities,
does not send a second message, and obtains revised Luna/strong typed
approvals before one provider approval and PR registration. This is the
single-task plan-revision lane; old-head PR rejection feedback inside a
three-task chain remains a separate fault case.

CI now requires ten positive installed-host scenarios. The native runner
has a red/green interruption regression: SIGTERM kills an owned detached
scenario and emits a failing, sanitized partial summary instead of leaving
a process running. All ten scenarios were observed passing across two
bounded local batches (seven prior to an outer command timeout, three in a
fresh follow-up); the outer-timeout attempt itself was **not** reported as
a successful complete matrix. The next gates remain the exact historical
C terminal recovery-blocker disposition and scope-limited compiler-enforced
refactors behind this completion/fault matrix.

The first **behavior-preserving type extraction** is now guarded by those
tests: `resolveIssuePullRequestObservation` distinguishes an observed remote
open PR, an immutable registered work product retained after GitHub failure,
a registered PR outside bounded discovery, an unavailable lookup, and a PR
not found in the bounded window. The window is deliberately **not** treated
as confirmed remote absence. The review pipeline consumes that discriminated
union in an exhaustive `never`-checked switch. `pnpm typecheck:invariants`
compiles negative cases under the workspace's existing strict null and
optional-property rules; CI runs it independently from runtime tests. The
full A→B→C host contract and focused native review regressions passed after
this extraction. Historical terminal recovery projection is still an
upstream host question, not a reason to silently erase its evidence.

The next tiny boundary decoder removes an unsafe cast from GitHub's raw PR
state to `OPEN | CLOSED | MERGED`. Unknown provider values now fail closed
as unavailable discovery rather than silently becoming an apparently
empty remote window. Focused tests and the full A→B→C installed-host
contract pass with that stricter runtime check.

Another isolated boundary test rejects a present but malformed remote
`headRefOid` before it can authorize a native head-bound verdict card.
Missing head evidence retains the existing read-only `git ls-remote`
fallback; a malformed nonempty SHA is unavailable evidence, not a valid
commit. An older unit fixture that used a six-character pseudo-SHA was
replaced with a 40-character Git object ID without weakening its immutable
head-retention assertion.

### Confirmed upstream host blocker (2026-09-29)

The opt-in real-PostgreSQL `pnpm test:contract:terminal-blocker --require-safe`
reproduces the original C-style inconsistency on unpatched Paperclip
`2026.916.0` (strict exit 2). A **host-created** failed worker run receives
one active recovery action; the installed automatic recovery service settles
it as `outcome: blocked`, `automaticRecovery.replay: blocked`. After a
board-owned merged work product and ordinary terminal issue transition, the
host issue read model reports `done` **and** an actionable
`legacy_execution_requires_reconciliation` blocker from that resolved run.
The previous generic-failure experiments did not exercise automatic
settlement and therefore cleared their blocker; they were not evidence
against this case. Do not mask this host field in the adapter or treat a
resolved unknown-effect audit as replay permission. An upstream host
projection/reconciliation contract must distinguish historical evidence
from the current actionable hold before claiming this final invariant
green. The ten positive adapter scenarios remain independent and passing.
