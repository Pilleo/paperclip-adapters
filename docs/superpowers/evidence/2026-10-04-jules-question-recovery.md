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
