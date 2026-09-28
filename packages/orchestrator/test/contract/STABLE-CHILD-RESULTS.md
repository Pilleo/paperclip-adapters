# Stable-ownership child plan review (v3)

## Proven vanilla contract

On installed, unpatched Paperclip `2026.916.0`, authenticated process workers
and real disposable PostgreSQL establish this sequence:

1. Jules creates a **bootstrap-owned child** and checkpoints its identity.
2. A later parent monitor poll activates the child for the orchestrator.
3. An actual orchestrator run **scoped to that child** creates the addressed
   reviewer card targeting the parent document revision, then parks the child
   in backlog and finishes.
4. Jules observes the exact card and settled bootstrap run, then assigns the
   child to Luna. The implementation parent remains assigned to Jules.
5. Luna submits the typed verdict and finishes its own child. Jules may consume
   the verdict even while that reviewer process is still active.
6. The same sequence creates a distinct Terra child for the same revision after
   Luna approval. Parent ownership and the fixture's session handle are stable.

Both approval and rejection were consumed by a genuine parent monitor wake;
the complete Luna-to-Terra control-plane ladder also passed. The contract calls
the production parent transport (`observeJulesChildPlanReview`), bootstrap
transport (`executeChildPlanBootstrap`), and native verdict bridge. No board
credential, run impersonation, or installed host patch is used.

## Why the bootstrap is necessary

- A parent-run POST **can create** a child-owned card, but the host then rejects
  reviewer startup with `continuation_source_context_missing`.
- A reviewer cannot bootstrap an addressed card for itself: the host returns
  `422: Agents cannot address issue-thread interactions to themselves`.
- A different agent running on the child supplies valid source-run provenance.
  Assignment occurs after that run settles; there is no parent handback.

These are measured host behaviors. The old HTTP fixture that synthesized a
creation-time 409 has been relabeled as a transport fixture, not a host proof.

## Run the positive contract suite

Final measured suite: `run-de3dd8ba6f08`, exit 0, all three scenarios passed;
reports: `/tmp/paperclip-child-review-final/`. It includes loading the pending
native assignment before submission and loading an already-recorded assignment
on a subsequent reviewer invocation.

```sh
CONTRACT_REPORT_DIR=/tmp/paperclip-child-review-results pnpm test:contract:child-plan-review --require-safe
```

The legacy negative concurrency suite remains separate:

```sh
pnpm test:contract:plan-handback --require-safe
```

The latter still intentionally reports no-go for read-then-PATCH parent handback;
it does not describe the v3 stable-parent protocol.

## Implementation and activation

The common v3 descriptor binds company, parent, provider session/activity,
document revision, stage, author, bootstrap principal, and reviewer. Its
content-derived key identifies one child and one card. It is distinct from
legacy v1/v2 keys so migration cannot relocate it onto the parent.

Managed Jules configuration now includes `planReviewBootstrapAgentId`, pointing
to its orchestrator. This enables the child protocol for **new** plan turns.
Existing parent-owned v1/v2 checkpoints retain their compatibility paths.
Directly configured Jules agents can set this field to a distinct, authenticated
orchestrator agent with permission to create the child card.

Jules persists `childPlanReview` before creation and after receiving the child
ID. A bounded complete issue search reconciles a lost creation response.
Bootstrap reuses an existing exact pending card after validating its source run.
Jules keeps its native monitor scheduled at the short review-continuation
cadence while waiting (rather than the ordinary 15-minute coding cadence), verifies the typed
verdict, and uses its existing journaled provider approval/revision mechanisms.
Failed or ambiguous bootstrap evidence is surfaced rather than replaced with
another task. Exhausted child limits are explicit errors; no silent fallback
to unrelated tasks is added.

The orchestrator recognizes child-scoped bootstrap runs before generic project
scheduling (including runs that carry both project and issue scope). Valid v3
children are excluded from generic PR/recovery/delegation reconciliation.

Reviewer tooling bypasses parent handback for v3 cards. Already-recorded child
verdicts produce a typed recorded-result assignment instead of asking for a new
decision. Own-child completion preserves parent ownership and refuses foreign
workflows. A post-verdict child cleanup hold does not suppress an otherwise
validated parent verdict; the parent does not clear that hold.

## Validation scope

The real-host fixture uses process workers, not model-generated reviews or a
Google Jules cloud session. Provider approval, rejection relay, and checkpoint
replay are covered through the actual Jules execute boundary with controlled
provider responses. A live provider canary remains a separate deployment check.

The host may cancel an early addressed wake **before it starts**, while the
child still belongs to bootstrap. The later ordinary assignment starts the
reviewer on the same card. The proof asserts no active reviewer cancellation
and no Jules owner-run cancellation in the child ladder.

No live task, hold, managed agent configuration, or installed host was modified
while implementing and verifying this protocol. The rebuilt adapters have not
been reloaded by this task.

## Unit/build verification

- Common: 181 tests passed (`run-b70bf11480f0`).
- Jules: 800 tests passed, no excluded files (`run-f58a708ab729`).
- Orchestrator: 872 tests passed (`run-92291e020fc8`).
- Workspace build passed (`run-366cd4741c38`).

The offline orchestration-regression and retry-policy fixtures had unmocked
session-document/interaction/comment calls to the live API. Their missing
transport mocks are now explicit, with fail-fast network guards. No test
timeout was increased to conceal those calls.
