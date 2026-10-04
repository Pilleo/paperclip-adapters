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
