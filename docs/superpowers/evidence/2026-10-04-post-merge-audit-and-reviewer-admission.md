# Post-merge audit and native reviewer admission

## Preserved campaign exception

The user merged campaign PRs #19–#21 through standard two-parent commits. The
original safeDecimal task MAZ-1638 is done, but PR #21 merged before its strong
native verdict. Its original failed reviewer/card audit remains intact; the
proposed restore-to-todo execution reconciliation was not sent after that merge.
The original strict campaign remains invalid with `04_terminal_proof_incomplete`.
No retrospective review can manufacture pre-merge evidence.

## Independent audit of the exact merged commit

An isolated checkout at merge commit
`2d2ac4f741debd887f9dbc73241578b04630d1ef` is retained under
`/tmp/paperclip-post-merge-audit-AR1bh4/repository`. The actual task requires only
trimmed strings representing finite **decimal** numbers and preservation of all
other exports. Rejecting padded whitespace is consistent with that contract.

The original safeInt and safeDecimal tests pass, and comparison with the first
merge parent's module verifies safeInt is unchanged. Independent boundary tests
pass for decimals, exponent notation, invalid/non-string input and overflow.
Three decimal-only regressions fail (`run-2998218911de`):

| Input | Actual | Required |
| --- | --- | --- |
| `0x10` | 16 | null |
| `0b10` | 2 | null |
| `0o10` | 8 | null |

The cause is direct `Number(value)` conversion without decimal syntax validation.
The isolated audit suite has 9 passes and 3 failures. Its tests are retained in
`/tmp/paperclip-post-merge-audit-AR1bh4/safeDecimal-post-merge.test.cjs`.

Separate corrective task **MAZ-1740**, `827d3625-7a89-41cc-a4df-9d66e9233f0b`,
was created in the existing disposable project (`run-1c80fd5f2db2`). It requires
failing radix regressions before implementation, preservation of existing decimal
and safeInt behavior, one follow-up PR, normal native plan/PR reviews and
user-owned start/merge gates. It has a distinct post-merge audit marker; it is not
a replacement campaign source, session, card or retrospective approval. No
operator code/product patch or provider message performed this correction.

## Remaining campaign liveness failures

GET-only inspection found:

- MAZ-1644/describeParity waits on deferred strong plan child MAZ-1739,
  `1114e1fa-0a34-4f34-bc63-6ff189695107`, with no card. The strong reviewer is in
  `error`, a prior-run outcome, not an administrative pause.
- MAZ-1653/hyphenKey waits on Luna child MAZ-1712,
  `9e5b870f-d5e8-4692-9be4-e0972a64c70c`. Exact native card
  `8eb25ba8-bf1e-445a-bdbe-90a8b718b7b0` remains pending. Its old queued run
  `1ec0b5bf-4bae-41c6-ae41-541f1649f853` was cancelled before starting during
  earlier reload admission; no active reviewer or execution blocker is present.

Their original provider sessions remain `4540481991596065044` and
`1325682972099713236`. Direct provider inspection shows only generated plans and
`COMPLETED` state (`run-9a99f1e90879`, `run-9fad3aa2dcc2`), not proof of
implementation or native approval. Successful Paperclip poll runs cannot be
counted as provider progress.

## Correction and regression evidence

Plan bootstrap/coordinator and PR bootstrap/activation now distinguish
administrative `paused`, `terminated` and `pending_approval` holds from last-run
`error`. Those administrative states remain held; no agent pause/approval state
is changed.

An already addressed blocked/backlog plan child may resume its **existing**
pending card only after verifying the original parent/revision/descriptor,
successfully settled child-scoped source, no active scoped run, and the addressed
reviewer's identity/admission. Historical reviewer runs must all be verifiably
cancelled before starting; any started, failed, succeeded or uncertain terminal
execution requires its separate typed recovery path. Native execution holds are
not cleared. One normal child transition admits a fresh run; no reviewer/card
replacement or operator wake is used.

Eleven plan regressions first failed (`run-d576219097a2`), then all 32 tests pass
(`run-b3b9d623f5ca`). Four PR admission regressions first failed
(`run-935106bc4586`), then all 30 existing/quota/admission tests pass
(`run-91340116656c`). The full workspace build passes (`run-84c8c3371313`).

The new mandatory `--autonomous-merge --reviewer-error` lane uses initially
errored Antigravity ACP reviewers with actual native MCP permission requests,
real PostgreSQL and unmodified installed hosts:

| Host | Run | Duration |
| --- | --- | --- |
| 2026.916.0 | `run-87fb08c08d85` | 319.608 s |
| 2026.1001.0 | `run-4eb5911df9ae` | 332.696 s |

Both prove one provider create/approval, two native plan cards, two exact-head
native PR approvals and preservation of all original cards and the pending user
merge gate across restart. Observation-driver mutations after start are zero.

Clarification of earlier evidence: plain `--autonomous` selects authenticated
process reviewers, not the external ACP fixture. Earlier plain-autonomous passes
prove native plan/restart behavior but should not be cited as ACP permission
qualification. The explicit merge lane above and mandatory question/conflict
lanes use the external ACP/native MCP path.

Live deployment and fresh paid-provider native decisions are separate subsequent
receipts; controlled-host passes do not by themselves prove the remaining live
cards have resolved.
