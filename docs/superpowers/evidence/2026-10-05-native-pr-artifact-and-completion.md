# Native PR artifact access and completion

## Live defect

PR #27 strong-review run `42b41db0-d882-46a4-bbbf-0176eca19f0d` retrieved the
addressed assignment for head `6e48d16b37085c581ebb9dfb9073e196c3c17b02`, but
the host checkout was on merged main and did not contain that PR head. Model
`run_command`/clone/diff tools were denied by the read-only policy. The native
assignment supplied only the PR URL and SHA. The model truthfully reported
that it had not inspected the code and had submitted no verdict, yet the
adapter returned success and the host continued the unresolved job.

The record and final log were inspected before any recovery. No free-text
decision, manual reviewer wake, public GitHub review, or replacement native
card was used.

## Contract fix

- The existing assignment MCP read supplies a bounded complete artifact:
  changed-file contents at the exact head and a diff between immutable commit
  identifiers. GitHub comparison status handles removed files, without relying
  on optional `gh pr view` change-type fields. Pre/post PR metadata and file
  completeness checks fail closed on mismatch. Raw and serialized output,
  subprocess concurrency, and wall time are bounded; code is never truncated
  into a supposedly complete snapshot. No checkout is modified.
- Resolved run-scoped GitHub read environment is forwarded to the MCP child;
  native agent/run/API identities cannot be overridden by adapter environment.
- The Antigravity adapter checks the actual running heartbeat authority and
  owned native card before provider work. A native helper with no valid
  assignment does not become ordinary successful coding work.
- A successful native turn requires the exact addressed card's structured
  result and current physical resolver run. Prose-only completion becomes
  `native_review_result_missing`. Recorded replay checks bind the helper's
  exact PR head/stage/key, plan revision/key, or question generation/key and
  require attributable succeeded prior resolver evidence.
- Explicit host status-only invocations keep their mutation restrictions and
  receive no native decision MCP server. Their success is a status report,
  never a substitute verdict.
- Managed reviewer instructions explain the authoritative MCP artifact rather
  than requiring denied model shell commands. ACP read-only and deny-all
  policies and the three permitted native MCP method names are unchanged.

## Verification

The prose-only false-success regression was red at `run-0a5b049e346f`.
Deletion and immutable-diff ABA regressions were red at `run-96b5a12050bd`.
Recorded-target, missing-assignment, and status-only regressions were tested
red before applying their guards. The serialized-wire-budget regression was
red at `run-5cc1b91884b4`.

Builds and focused suites passed. Full workspace suites passed at
`run-80c4e7bf2c89`. The direct private-PR artifact probe retrieved the exact
head's two files and diff without model shell permission.

Real external ACP positive and prose-only negative contracts passed on both
Paperclip 2026.916.0 and 2026.1001.0 in
`/tmp/paperclip-native-artifact-contracts/status.json`. Final reviewed builds
are verified separately in `/tmp/paperclip-native-artifact-final/status.json`;
all four final positive/prose-negative lanes passed on the two supported hosts.
The negative actor claims approval but never submits the native verdict;
verification requires a failed run, an unanswered card, and no merge gate.

Mandatory commit hooks passed the final build and all 2,284 workspace tests
at `run-a527b4ec4d45`. Workflow lint passed. Backlog lint still reports only
the ten pre-existing historical frontmatter failures.

## Verified deployment

Journaled reload `/tmp/paperclip-native-artifact-live-reload/receipts.jsonl`
completed successfully (`run-77a2805d4c16`). Post-reload orchestrator heartbeat
`9b90df41-59b8-42ff-b92a-58d3853a0ca8` succeeded. Startup logs explicitly loaded
the built orchestrator, Jules, and Antigravity `dist/index.js` packages.
The live server remains Paperclip 2026.916.0. Both original source issues remain
in_review without execution blockers and await their user-owned merge gates.

## Campaign and independent code audits

User PR #26 merge `8ef59beed2edd405866aba14561c5f914d878fd1` has two parents;
MAZ-1654 reconciled to done and its work product to merged.

PR #27 head `6e48d16b37085c581ebb9dfb9073e196c3c17b02` passed 94 repository
tests and 35 independent decimal audits. These cover radix rejection, signs,
fractions, exponents, finite extremes and overflow, signed zero, malformed and
untrimmed strings, and non-string rejection without coercion. The safeInt
implementation and numeric export surface were preserved.

Luna rejected original PR #28 head `3da667e687d3c857be3043a3ebddb855056151e2`
because `multiplyNumberPair('0', '-2')` returned -0 where its test required 0.
The typed card `da253048-c413-4d4e-8c8e-b6134be63534` was resolved by succeeded
run `e3fb5665-6a63-4b4a-a4f3-181876227642`. Normal adapter feedback delivery
continued original Jules session `14113825466128029126`, which pushed head
`ca8ad7c8722ba932e647a06061a52b3bb8ca2fb1` on the same PR. That head passed
101 repository tests. Four additional checks loaded the actual source modules
from both pinned heads and verified the combined decimal/pair/multiplication
behavior without merging or editing either checkout.

Audit scripts, logs and receipts: `/tmp/paperclip-pr27-audit-sedklyal/`.

Both current PR heads subsequently received successful exact-head Luna and
strong approvals. User merge gates observed:

- PR #27: `3f34b272-78d6-4840-8b7e-89176880ab65`.
- PR #28: `1e8f48d0-e78f-47d4-a15a-0c13e5490137`.

The original PR #21 pre-merge proof exception remains permanent; this follow-up
fix and its reviews do not supply retrospective qualification evidence.
