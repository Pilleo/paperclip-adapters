# Vanilla native-plan handback concurrency contract

For the implemented stable-parent alternative, see [STABLE-CHILD-RESULTS.md](./STABLE-CHILD-RESULTS.md)
and run `pnpm test:contract:child-plan-review --require-safe`. The original
negative handback experiment below is retained independently.

This opt-in experiment qualifies the **settled-reviewer, separate-orchestrator
PATCH handback** against installed Paperclip `2026.916.0`. It uses the actual
`decideNativePlanReviewReconciliation` decision function, real PostgreSQL,
authenticated HTTP routes, and genuine host-dispatched process-adapter workers.

## Run

Requires Node 24+, installed workspace dependencies, and an installed npm
Paperclip `2026.916.0` (including its embedded PostgreSQL test support).
The default install is `~/.paperclip/cli/current/node_modules`. Override with
`PAPERCLIP_CONTRACT_NODE_MODULES=/absolute/path/to/node_modules`.

```sh
pnpm test:contract:plan-handback
```

Reports go to a new temporary directory printed at completion. To retain them
in a known location:

```sh
CONTRACT_REPORT_DIR=/tmp/plan-handback-evidence pnpm test:contract:plan-handback
```

Run one controlled scenario or enforce the integration gate:

```sh
pnpm test:contract:plan-handback --scenario=starts_after_read
pnpm test:contract:plan-handback --require-safe
```

The opt-in `stable_child_jules_v4_create` scenario runs the **actual Jules
executor** on an initially unseeded provider session. A stateful loopback Jules
fixture accepts exactly one `POST /sessions`, serves that original session's
plan and activities across authenticated child-review runs, accepts exactly
one `approvePlan`, and exposes one resulting PR at an actual disposable local
Git commit. A read-only stateful `gh` fixture serves that commit. Its separate
external test actor can create ordinary two-parent merge commits only for the
exact reviewed head and two distinct addressed native-approval evidence inputs; it
refuses CLI merges and stale-base dependent PRs. This scenario uses the
installed host's real PostgreSQL and run-scoped worker credentials; no provider
API key or live GitHub repository is contacted. The normal v4 scenario separately
covers adopting an already durable session. In the independent
`stable_child_executor_pr_board` scenario, the external merger's evidence
inputs **are** checked against the host's real addressed Luna/strong verdict
cards and authenticated source/reviewer runs before it creates the two-parent
commit. These are two complementary single-task scenarios, not a complete
A→B→C dependency-and-merge scenario.

`stable_child_jules_v4_create_lost` adds a controlled accepted-but-lost
provider-create response. The provider persists its original session but drops
the HTTP reply; the real Jules run fails closed. A board-authorized **typed
execution recovery** records the observed completed create on the exact failed
run. Its native continuation lists the remote session before proceeding with
both addressed plan verdicts, one approval, and one PR. The contract rejects a
second create; it does not silently retry the uncertain POST or write a manual
checkpoint. The board actor exists only inside the disposable installed-host
contract; no live task is recovered by this scenario.

`stable_child_chain_abc_complete` seeds A→B→C as three issues in **one**
disposable company and one authoritative Git-backed project, with real
PostgreSQL `blocks` edges A→B and B→C. B/C begin unassigned and have no
provider run before their predecessors merge. **For each task**, the actual
Jules executor creates its own provider session, receives addressed Luna and
strong plan verdicts, approves the provider plan once, and registers one PR
at a real local Git head. The **actual orchestrator** promotes its PR and
routes distinct Luna and strong review children with authenticated bootstrap
and typed reviewer-run attribution. A distinct external actor produces an
ordinary two-parent merge only after both current-head native approvals.
Further real orchestrator heartbeats converge each issue to `done` and its
work product to `merged`; B's `task_start` is approved via the native board
route only after A's merge, and C's only after B's. Paperclip's status-only
`missing_issue_comment` follow-up writes only an execution-status comment;
it never substitutes for a verdict or repeats a provider effect. The gate
requires A/B/C final files, three distinct sessions, exactly one PR per
issue, no actionable terminal blocker, and no pending terminal merge gate.
The fixture pre-populates each disposable Git PR branch after the previous
merge, before that task's provider returns the URL; no fixture PATCH repairs
issue status or supplies a verdict mid-test.

`stable_child_chain_abc_lost_b_create` repeats the entire same-host chain but
lets Jules's `POST /sessions` for **B** succeed remotely and destroys its
response. The first B run fails closed and the host records its exact failed
execution. A local-trusted board operator with a real active company
membership resolves that run through the native typed execution-recovery
route, recording the observed completed provider create. Jules's resumed
run lists and reattaches that one B session; A, B and C still finish their
distinct plan/PR reviews and external merges. The gate requires exactly
three provider creates and three approvals overall. This injects a failed
worker run, **not** a Paperclip server-process restart; the retained-storage
restart during a running chain remains a separate test milestone.

`stable_child_chain_abc_lost_b_approval` drops the response after the provider
accepts B's exact typed strong-plan `approvePlan`. The approval activity's
timestamp is recorded **when that request is accepted**, after the durable
effect attempt begins; a backdated activity cannot prove that this effect
succeeded. The real Jules executor reads that same session's activities,
confirms the started effect without reposting it, registers B's PR, and the
whole A→B→C native-review/external-merge chain still converges. A lost
provider response alone is not a reason to invent a verdict or issue a second
approval. Unlike lost session creation, this scenario needs no operator
reconciliation when exact same-session provider activity verifies the effect.

`stable_child_jules_v4_revise_message_lost` exercises the third provider
mutation boundary without a second session. An addressed Luna card rejects
the original plan once. Jules sends one revision `sendMessage`; the provider
persists the user-message echo and a new plan activity, then drops its reply.
Jules reads the **same session's** activities before another mutation, and
distinct revised Luna/strong cards approve the new revision. The contract
requires exactly one create, one sendMessage, one approvePlan, three native
cards (old rejection plus two revised approvals), and one registered PR.
This is a single-task plan revision, not a full-chain PR-feedback amendment.

The independent CI runner `node scripts/paperclip-host-contract-gate.mjs`
requires all ten positive installed-host scenarios, each in a fresh report
directory. It rejects missing, mismatched, stale, malformed, or unsafe
evidence. Each scenario has a bounded deadline; SIGINT/SIGTERM kills its
owned process group, writes a failing `interrupted` summary, and does not
start another scenario. The original unsafe read-then-PATCH handback
characterization remains separate and is **never** a positive CI gate.

The independent `disposable-host-live.mjs` contract now stops and restarts
the **actual Paperclip server process** with its embedded PostgreSQL data
retained after acknowledging a company, an unassigned review issue, and one
exact-head native card addressed to an invokable reviewer. It first confirms
all addressed runs are idle, then requires the same card ID, pending status,
immutable key, reviewer identity, and issue after restart. This protects
pending native review persistence but does not claim to restart a running
Jules approval or an in-flight A→B→C provider effect.

`jules-server-restart.mjs` crosses the **actual approval-to-PR boundary**:
the installed Jules adapter creates one remote session, bootstraps its own
v4 plan children, receives two distinct authenticated typed verdicts, and
durably confirms one provider plan approval. Its provider fixture withholds
the PR output. At fleet idle the test kills and relaunches Paperclip with
the same embedded PostgreSQL data and Jules session-store directory, verifies
the original session/effect journal and native card/run IDs survived, then
releases the original provider session's PR output. One issue work product
must register at that exact Git head, with no second provider create,
approval, or plan verdict. The server startup log must load Jules's built
`dist/index.js` in both processes. A separately tested exact-run status-only
comment handles Paperclip's `missing_issue_comment` follow-up without
updating provider state, deliverables, or review verdicts.

### Pinned-host terminal recovery gap (opt-in, separate from positive CI)

`pnpm test:contract:terminal-blocker` starts the real v2026.916.0 host
services on embedded PostgreSQL, admits one **host-created failed worker
run**, and calls the installed `settleUnrecoverableExecutions` service. It
asserts the action is resolved as `outcome: blocked` with
`automaticRecovery.replay: blocked`. A board-owned merged work product and
terminal issue transition then exercise the host's ordinary issue read
model. On the pinned host the result reports `safe: false`: `done` still
exposes `legacy_execution_requires_reconciliation`. This reproduces the
historical C-shaped *projection boundary*, rather than a manually settled
recovery action (which does clear the blocker). The static merged work
product isolates the host projection; this is **not** a second full
provider/PR lifecycle test.

Use `pnpm test:contract:terminal-blocker --require-safe` for upstream
qualification: it exits **2** on this known defect, and must pass only when
a new pinned host version distinguishes historical no-replay audit evidence
from a current actionable hold without authorizing a failed provider retry.
Do not put this negative characterization in the positive CI matrix, clear
the evidence by issue-status repair, or silently reinterpret it as success.

Exit codes:

- `0`: characterization completed; **inspect `safetyGate` / `integrationAllowed`**.
- `1`: harness error or unmet fixture precondition. This is not proof of a host limitation.
- `2`: `--require-safe` detected an integration failure in an otherwise completed experiment.

The negative race is expected to be *observed successfully* on this pinned host.
A passing characterization command is not deployment approval.

## Isolation and authentication

Every scenario runs in a separate process with an ephemeral loopback server,
temporary `PAPERCLIP_HOME`/instance, fresh signing secret, company, membership,
agents, issues, and embedded PostgreSQL. No live API URL, provider key, repository,
or board credential is used. The only database inserts seed static fixture
entities; **all heartbeat runs and typed verdicts are created by the host and
authenticated workers**, not by injecting run rows or HTTP actors.

The installed `actorMiddleware` verifies the worker JWTs. The harness verifies
that an existing issue denies unauthenticated access and rejects an invalid
bearer token. The reconciler is assigned a maintenance issue so its cross-issue
PATCH is attributed and charged against the host's cross-issue cap.

The fixture matches the observed orchestrator role (`general`), task-assignment
permissions, and `maxConcurrentRuns: 1`. Automatic periodic ticks are disabled
for deterministic tests; test wakes use the normal `heartbeat.wakeup` scheduler
admission path. This is not a claim that every live policy or configuration is
identical. Review work submitted after the verdict is fixture-controlled host
work inspecting the answered card, not a retry of a terminal run's verdict.

## Barriers and evidence

The worker POSTs an event using its run token to the fixture coordinator. A
waiting event's response is held until the test releases it. The coordinator
checks company, agent, and the currently running run against the real database.
The fixture does not patch installed host code or add production adapter hooks.

- `SOURCE_CARD_READY`: real Jules worker created its revision-bound card.
- `VERDICT_WRITTEN`: real reviewer submitted the typed verdict; it can be held active.
- `VERDICT_SETTLED`: all prior executions and handlers have settled.
- `EVIDENCE_READ`: real reconciler loaded issue/card/document/source/reviewer-run evidence.
- `PATCH_READY`: hold after the last evidence read, immediately before the client PATCH.
- `COMPETING_REVIEWER_STARTED`: competing process and database confirm it is running.
- `PATCH_RESULT` or `PATCH_RESPONSE_LOST`: response observed or intentionally discarded.
- `JULES_STARTED`: Jules process actually starts and reads the original answered card.

The queued case holds Luna on a different fixture issue to exhaust its one
execution slot, admits work for the reviewed issue, then releases that capacity
after the tested PATCH. No queued/running state is written directly.

Barrier order drives races; 50ms polling is only used to observe bounded host
conditions. A missing Jules continuation is reported as **not observed within
30 seconds**, never as proof that it can never run. Teardown releases barriers,
drains host execution, waits for PATCH handler completion (not just disconnected
client sockets), closes the server, and cleans up PostgreSQL and temporary home.

Each JSON report contains barrier sequence, mutation responses, issue locks and
policy, typed verdict attribution, run statuses/timestamps, wake requests, and
recovery holds. It excludes tokens and full runtime environment/provider logs.

## Scenario matrix

| Scenario | Controlled boundary |
| --- | --- |
| `baseline` | Reviewer settles before reconciler reads |
| `active_before_read` | Answered reviewer held running before evidence read |
| `queued_before_read` | A new reviewer is queued before evidence read |
| `starts_after_read` | New reviewer is running after `PATCH_READY`, before PATCH |
| `queued_after_read` | New reviewer is queued after `PATCH_READY`, before PATCH |
| `overlapping` | Two normal wakes for the same maintenance issue at concurrency one, followed by replay |
| `lost_response` | Client discards handback response, new reconciler reads authoritative state |

The reviewer process records a normal fixture execution comment to avoid
confusing missing-disposition follow-ups with the verdict itself. Decisions
are only native typed card mutations. Any additional host-generated follow-up
runs are retained in the evidence.

## Limits

This fixture proves control-plane behavior, not LLM quality, full provider
session resumption, or the complete Luna/Terra ladder. `JULES_STARTED` proves a
host run started and inspected the card; it does not invoke Google Jules.
Overlap results apply to the tested same-agent concurrency setting. An adapter
mutex cannot serialize this agent against the host's reviewer dispatcher.

If the stale PATCH cancels the competing reviewer, leave the production
mutation executor disconnected. The required upstream contract is an atomic
conditional handback that compares the expected stage/owner/revision and
absence of active reviewer execution under the dispatch lock, then records a
durable Jules continuation. Do not substitute a second client read for that
contract.
