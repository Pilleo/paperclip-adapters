# Native Jules question recovery and presentation

## Failure

MAZ-1638's original Jules session `392683388696176766` completed without a PR
after its revised plan was natively approved. Its question reviewer failed with
`continuation_source_context_missing`: the executable child question was created
from the parent run. The adapter treated a blocked child with a pending form as
a healthy wait indefinitely. The parent exposed the agent's `answer/escalate`
protocol to humans, left `allowOther` unspecified, and reported `in_progress`.

## Correction

- Native question cards are created by a fresh child-scoped bootstrap run. The
  parent checkpoints the child before activation; the coordinator requires the
  settled bootstrap and exact addressed reviewer/run provenance.
- Terminal reviewer failures get bounded fresh scoped generations. The old
  question card is retired using its returned ID. Terminal runs are evidence,
  not jobs to replay. Existing blocked legacy bridges follow this path after
  inspecting their exact failed reviewer run and confirming no active run.
- Humans see a single direct `reply` field and `Send to Jules`. Agent routing
  choices stay on the addressed reviewer child. Every question explicitly sets
  `allowOther: false`; an actual human escalation uses a human-only direct-answer
  form.
- Feedback waits are `blocked`. Paperclip clears monitors for that status, so
  the orchestrator coordinates the scoped child instead of reopening the parent
  and resetting its provider cadence. A settled native answer resolves the
  exact parent reply form, which resumes its original Jules owner.
- Answer delivery is journaled before the provider POST. An accepted-but-lost
  response is reconciled through the exact original-session message echo, never
  blindly sent again. Required native plan/PR approvals and user merge gates are
  preserved.

## Qualification

The old compiled package failed the real-daemon behavioural control at exactly
`Question source must be child-scoped` (`run-5b25f7797949`). Earlier positive
attempts exposed monitor reattachment and omission of the failed question-card
ID; those failures are retained as diagnostics, not qualification passes.

The complete `--autonomous-question-recovery` lane passes on both unmodified
installed hosts, with real PostgreSQL, native run credentials, built adapters,
controlled external provider/Git actors and a GET-only observer:

| Host | Run | Duration |
| --- | --- | --- |
| 2026.916.0 | `run-3733c6a7bfbb` | 469.204 s |
| 2026.1001.0 | `run-c64e58fb1feb` | 486.109 s |

Each includes an actual question reviewer failure, restart during the blocked
wait, typed fresh recovery, one answer to the original provider session, one
provider create/plan approval, native PR approvals and preservation of the
original pending merge gate across restart. Retired question-history cards keep
their exact cancelled/expired states; native plan/PR verdict cards must still be
answered, and no card can be replaced unnoticed. CI requires this lane on both
host targets.

The full Jules coverage suite passes (`run-495f86b6bae5`); the orchestrator suite
passes all 1048 tests with bounded workers (`run-a5af716854d3`). The initial
unbounded concurrent run hit CLI-test deadlines and is not counted as a pass.
Source identity, persistence-before-send, lost-ack restart/no-replay, waiting
status and human presentation have focused regressions.

Live deployment/recovery is verified separately through the journaled drain.
No operator answer or provider-message one-shot is used to repair MAZ-1638.

## Live multiline transport correction

The first journaled reload loaded the fix and migrated the old routing form to
a direct human reply with `allowOther: false`. The live child creation exposed
Paperclip's description formatter normalizing JSON-escaped newlines inside the
provider question. Single-line fixtures had not exercised this shape. A failing
round-trip test reproduced it (`run-a515bf05cb15`). New markers URI-encode the
question; the reader repairs only legacy literal control characters within JSON
strings and still validates the strict identity schema.

A rejected receipt left identical deferred children before either ID could be
checkpointed. Registry reconciliation retires duplicates only when every child
matches the exact identity, is still bootstrap-owned/backlog, and has no own run
or card history; any active or decided duplicate fails closed. These positive
and negative checks pass (`run-6645e55a0afe`). The complete real-host recovered
question lane now uses the multiline provider message and passes on the baseline
(`run-d0e09b62e53d`, 455.143 s).

The reload receipt is under `/tmp/paperclip-question-live-reload-4EL17A`.
One independently stranded, unstarted Luna queue row was retired through its
native cancel API before admission hold, after proving both start timestamps
were null and retaining its undecided verdict card. No reviewer decision was
invented by that maintenance operation.

## Stock Codex question-tool transport

After source-context repair, the live stock Codex adjudicator could start but
had no `paperclip_review` tool: its managed home was reseeded with two stock
gateways, which also reported stale runtime-token failures. Successful prose
responses left the native question pending. Such prose is not a decision.

The managed question adjudicator now receives per-invocation Codex `-c` overrides
for the stdio question MCP and an explicit list of run-scoped environment names.
No credential value is persisted in config or metadata. The managed-agent
fingerprint/visible-field PATCH path applies this configuration normally. The
real installed Codex CLI accepts the override as an enabled stdio server
(`run-c6a9a6fc2379`). Fleet tests first failed on the missing transport, then all
22 passed; managed PATCH regressions also pass (`run-b9d4dd6d246c`).

A succeeded process whose exact pending question has no typed decision is now
a bounded protocol-recovery outcome, rather than an indefinite healthy wait.
The failing regression (`run-14aae84c4f73`) passes with this classification
(`run-b94b977f20ba`). No comments or final-response prose are promoted to answers.

The live parent reached Paperclip's cumulative 25-helper child cap after the
legacy malformed receipts. New generations use the standalone-helper alternative
only for that exact 422 response. The strict descriptor supplies the logical
parent; creator/company identity remain required, and a stable hashed title
supports a bounded native registry lookup after uncertain creation. Other
creation failures propagate. The helper retains the parent's project for normal
coordination. A cancelled recovery card requests one proof-keyed owner turn to
complete the already-started generation; it never authorizes a provider answer.
The targeted quota/identity/outbox tests pass (`run-fabf71256d9a`).

For a supplied standalone helper ID, coordination validates and advances that
exact helper directly instead of rediscovering it through company-wide search.
The regression rejects any company inventory read for this known-ID path
(`run-73badf6c03ca`). Parent-linked legacy duplicate reconciliation remains on
the generation registry path.

## Verified live recovery and original-session PR

The journaled reload of `14fa48c` completed under
`/tmp/paperclip-question-known-id-reload-GScwTC`, with successful orchestrator
reconciliation `6f0d4295-30f1-481b-8168-b25a44149b2f`. The standalone helper
MAZ-1735 (`6f05486b-3968-4a15-bc5f-7bc5f49c710c`) obtained the addressed typed
answer on card `c7976792-7c0e-40a4-8d97-1735063d6152`, resolved by adjudicator run
`f3749d06-bc46-400d-a832-a4a3721bf427`. That exact run succeeded and its issue and
agent identities were verified, rather than inferred from process prose.

The coordinator automatically answered parent card
`2d56ab75-bff7-4298-9699-d6a338195f51`. Its only question is `reply`, with
`allowOther: false`. The answer delivery journal has one confirmed
`send_provider_message` effect for the original session and question activity
`08571d849e9b4098b2d1b485db81cf15`, with receipt
`provider:question-answer-accepted`. Direct GET-only Jules inspection confirms
the exact answer marker in provider history: the session resumed `IN_PROGRESS`
and subsequently reached `COMPLETED` (`run-4bdbe3d09b82`, `run-08322ec68e66`).
No operator answer, provider message, or replacement session was used.

Jules published exactly one new safeDecimal PR, campaign
[PR #21](https://github.com/Pilleo/paperclip-adapters-e2e-20260923-vanilla-review/pull/21),
at `2026-10-04T05:10:55Z`, head
`f474e2af0d22198b7e2772784db23c50aea1f0c2` (`run-3974c5f1d327`). The next ordinary
provider poll registered that URL in the original durable session at
`2026-10-04T05:24:01.808Z` (`run-3cd8649519fb`). PR review and user merge remain
separate completion gates; provider completion is not campaign completion.

The strict campaign observation at `2026-10-04T05:18:28.019Z` shows 11 done,
2 in progress, 2 in review and 5 todo (`run-146bcf9676eb`). PRs #16–#18 have
merged. PRs #19 and #20 have two succeeded exact-head native approvals and await
the user's standard merges. This snapshot precedes PR #21 registration.

## Coalesced status-only run authority

Latest-head CI `37178769463` on `14fa48c` failed its baseline restart lane before
provider plan approval. The host rejected a deliverable mutation with its
status-only guard, while summarized run history reported `issue_monitor_due`.
The separate main CI and both Node build/test/package jobs passed; this failed
native lane is not a qualification pass.

The installed host's actual `mergeCoalescedContextSnapshot` reproduces a monitor
wake replacing `wakeReason` while retaining `recoveryIntent: status_only`,
`allowDeliverableWork: false`, `allowDocumentUpdates: false`, and
`resumeRequiresNormalModel: true`. The old compiled Jules classifier incorrectly
returned `normal` for that exact context (`run-c20e1d3f8531`). Wake labels cannot
override these durable host mutation restrictions.

Four new regressions first failed (`run-82300a5bd490`). The classifier now honors
the exact host status-only guards independently of wake reason and fails closed
when any required guard is missing. All seven classifier tests and both answer
outbox tests pass (`run-47642c06e3ea`), the Jules build passes
(`run-910509db98ef`), and the real baseline restart contract passes after the
change (`run-86f30f1d1995`, 41.714 s). The unmodified local contract also passed
before this change (`run-7517455c9a76`); it did not independently reproduce the
timing-dependent CI wake coalescence. Full exact-head CI must qualify the new
revision separately.
