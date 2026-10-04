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

## PR-review helper quota continuity

After registering PR #21, MAZ-1638 correctly entered `in_review`. The ordinary
coordinator then hit the same cumulative helper cap on the PR review child POST:
`422: Parent issue already has the maximum 25 child issues for this helper`
(`run-495b6e723399`). Reconciliation succeeded overall but held this native lane;
an `in_review` status alone did not prove that reviews could progress.

PR-review creation now uses a standalone reviewer helper only for that exact
422 quota error. Its stable title hashes the full existing PR/head/stage/reviewer
descriptor. The original source's company, project, immutable primary work
product, parent-card authority and creator principal remain required. A bounded
registry recovers an accepted creation after a lost receipt, and duplicate
identities fail closed. Bootstrap, activation and observation retain their own
child-scoped source/reviewer run requirements. This adds no replacement source
task or provider session and does not manufacture a parent verdict.

Standalone PR helpers are excluded from implementation scheduling. Jules's
deferred native rejection reader and the strict GET-only campaign observer also
discover their logical parent through the exact descriptor and hashed title;
normal parent-linked review histories remain valid.

The quota regressions first failed at the original rejection and missing
standalone correlation (`run-d0c11cb94858`). All eight quota tests and eighteen
existing child-protocol tests pass (`run-e2e1c4f7d84a`); the native orchestrator
routing set passes 53 tests before the two additional receipt/duplicate cases
(`run-98292fbfcf49`). Deferred rejection regressions first failed
(`run-7acbf7e58572`) and now pass alongside answer/status guards, twelve tests
total (`run-095c8ed240f5`). The full workspace build passes
(`run-d007dfeb8e22`). Live PR approval evidence is a separate post-reload gate.

The `29df73e` journaled reload completed under
`/tmp/paperclip-pr-quota-reload-h8n7es` (`run-aead203ce5fb`). MAZ-1736
(`5d42baaf-85de-4954-b686-0c0e9bc7bd87`) is the standalone Luna PR reviewer.
Card `8bb92e3e-a247-44ae-955d-a7334fe33fd7` was bootstrapped by its own scoped
orchestrator run `a9a07d45-df13-4d5a-a803-31d6779f00c5`; Luna approved it in
`ac2e049b-d4aa-4a1c-b28b-3562c3b3eab1`. Both runs succeeded with exact helper
scope (`run-23b40a25bcdc`). The next strong-stage helper is
`1af0429c-8d21-4233-8961-ddeabcf36df0`, card
`56f82ba9-820c-4f75-840a-bba0b2f48040`. These are native review cards for the
original PR #21 head, not replacements for prior decisions.

## Native MCP calls under restrictive ACP permissions

Strong review then exposed a separate permission boundary. Its successful
Antigravity runs reported `denied by pre-tool hook: Denied by user (*)` for
`paperclip_review.get_current_native_review_assignment`; no typed verdict was
submitted (`run-4d762b650e57`). A bounded observation timed out while this card
remained pending (`run-d91e2f8caf5b`), which is not a review qualification pass.
Free-text blocked summaries do not satisfy the native gate.

The ACP runtime now installs a per-invocation permission callback only after the
run-bound native review MCP bridge exists. Under `approve-reads`, it permits
only the three exact native control-plane tool titles, classified as `other`,
and only when the provider offers an actual `allow_once` option. The MCP itself
continues to verify the exact addressed card, issue, agent and run. Repository
edits, unrelated tools, ordinary workers, explicit `deny-all`, and persistent
always-allow requests retain their configured policy. Safe diagnostics record
only the known tool title, kind and permission decision.
An existing host permission callback has precedence; its explicit decision is
never replaced by the native-tool allowance (red regression `run-27fe406a33fd`).

The permission and executor wiring regressions first failed
(`run-0b0c3f81ea91`, `run-27c4db4d16f1`); the always-allow fallback guard also
first failed (`run-9f855f85b947`). All 32 Antigravity tests pass
(`run-a1ca6597d7da`), and the affected package builds (`run-34c474bfb093`).
The external native ACP fixture now requests permission before both assignment
reads and verdict/question submission, so the real-host CI lanes exercise this
boundary. Its two positive cases first failed without those requests
(`run-2ee82c6ebfce`); both positives and the denied-before-MCP negative now pass
(`run-62ead0b14241`).

With actual permission requests enabled, the autonomous real PostgreSQL/daemon
restart lane passes on baseline (`run-8e90ebc8e28d`, 179.797 s) and candidate
(`run-7226e9069a7f`, 184.540 s): one provider create/approval, two native typed
plan cards, and zero driver mutations after start. These runs precede the final
additional once-option guard. The external ACP read/write contract also passes
after that guard (`run-47c4fca730b8`): reads allowed and writes denied for all
restrictive aliases, with explicit `approve-all` retained.

## Oversized continuation transport and retained native hold

The permission fix `f267188` was journal-reloaded successfully under
`/tmp/paperclip-native-permissions-reload-oSEpij` (`run-d55f0dd3f0f1`). Its live
strong card could not be exercised: before that reload, reviewer run
`8c79ddb8-2e6b-4f56-b6d3-f49d84230eee` failed during `ensure_session` with
`acpx_session_init_failed: spawn E2BIG`. The helper is now `blocked` by native
execution recovery action `35321793-60a3-4619-bf37-bacba1974d07`
(`run-34184a6067d6`). The exact strong card remains pending, and the terminal run
is retained as failed. The host settled its automatic recovery; the read
projection has no active questionnaire (`run-aa86feeaff29`).

The actual failed run has a 127825-character execution continuation, duplicated
inside its wake. SDK 2026.916 serializes that wake into the single
`PAPERCLIP_WAKE_PAYLOAD_JSON` environment variable. Using that exact installed
serializer and the failed run's retained context reproduces kernel `E2BIG` at
132109 bytes (`run-2a0932a71c0b`). This is a process-start failure, not a native
review verdict or a PR rejection.

For a bound native reviewer only, oversized wakes now omit prior execution
continuation history from the provider transport while retaining the original
full host audit. Current issue identity, execution identity, host mutation
restrictions and task markdown remain unchanged. The wake is explicitly marked
truncated/fallback-fetch-needed; the reviewer must obtain its exact assignment
from the authenticated native MCP. An inconsistent issue scope or still-large
task payload fails closed rather than being silently truncated. Small reviewer
wakes and ordinary workers retain their original context.

Four regressions first failed, including actual kernel startup
(`run-b7b405e99a26`). All 37 Antigravity tests pass (`run-0d8c7e0c4c12`), and
the package builds (`run-fef45cc3a422`). The same failed live wake, serialized by
the stock SDK after projection, is 5065 bytes and launches the real Node process
successfully with exit zero (`run-2a0932a71c0b`). Scope is retained and the host
run's original payload is not modified.

The execution hold is a separate authority gate. Clearing it requires the
supported typed execution-reconciliation path with the exact failed run and
observed action outcomes. No manual reviewer wake, terminal run replay, new
native review card, operator verdict, or database repair was used to clear it.
PR #21's final strong approval and the 20-task campaign are therefore not yet
qualified as complete.

The bounded transport fix `2bc3d24` was built/tested with all mandatory hooks
(`run-eda32af77113`) and journal-reloaded under
`/tmp/paperclip-bounded-review-reload-gzbESd` (`run-4a609168abfa`). Reconciliation
`3853f4c5-e92f-415e-a94d-56ef132e68b3` succeeded. Post-reload evidence confirms
MAZ-1737 is still blocked with the exact recovery action/run above, its original
strong card pending, and no active addressed reviewer runs (`run-20c4dd41728b`).
The strict campaign observation remains 11 done, 3 in review, 1 in progress,
5 todo; PR #21 has Luna's exact-head native approval, while PRs #19 and #20
await the user's merges (`run-750885fcedce`, `run-4fefa3d14d37`).

## Conflict-lane observation checkpoint correction

CI on `f267188` (`37183400805`) reached later conflict qualification stages but
failed the baseline missing-required-PR lane and candidate manual-default lane
at the fixture's product-head assertion. Both diagnostics show the product had
already converged to the expected repaired head by the subsequent diagnostic
GET (`run-f83140489147`). The polling callback asserted immediately after seeing
resolved repair provenance, before a user merge gate existed; provenance and
head synchronization can be separate coordinator writes.

The observer now waits for the exact source's merge gate, then reads the current
product and asserts resolved repair provenance, the exact repaired head, and the
original reviewed SHA. It still verifies the same two native cards and no
post-repair reviewer runs. If a gate exists without valid repair provenance or
the correct product head, the test fails. No live adapter behavior or authority
policy changes in this fixture correction.

Both previously failing real-host contracts pass with actual ACP permission
requests and zero observation-driver writes:

- Baseline `--conflict-recovery-mode=agent --repair-agent-adapter=process --initial-no-pr`:
  `run-38cc2f596246`, 253.549 s; one same-session recovery message, one repair,
  original native cards/merge gate retained, standard merge and dependent release.
- Candidate `--conflict-recovery-mode=default`: `run-5aa7d6aac8c2`, 280.969 s;
  manual default across restart, external repair, zero agent repair operations,
  original native cards/merge gate retained, standard merge and dependent release.

Main CI on `2bc3d24` passed (`37205563187`); its full native workflow was still
running (`37205563197`) before this fixture correction. Later revisions require
their own exact-head CI result and are not qualified by an earlier green tree.
