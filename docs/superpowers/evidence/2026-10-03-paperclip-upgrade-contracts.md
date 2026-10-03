# Paperclip 2026.1001.0 upgrade contracts

## Scope

The installed live host and adapter SDK dependencies remain `2026.916.0`.
Candidate `paperclipai@2026.1001.0` was installed privately under
`/tmp/paperclip-upgrade-qualification-K2yQ1v/candidate`. Qualification uses real
isolated PostgreSQL, installed unmodified host services/daemons, authenticated
workers and built external adapters, with deterministic owned provider/GitHub
actors. No live service update or campaign repair is part of this work.

## New boundaries

- Exact baseline/candidate selection, actual installed-version checks, and
  CLI/server resolution from one installation. The gate cannot accept a baseline
  report as evidence of candidate compatibility. Both new gate tests failed on
  the original runner (`run-002f63a00bf2`), then all 22 gate tests passed.
- Real baseline-to-candidate database migration preserves acknowledged company,
  agent, issue and the exact pending native review card. Passed in 39.263 seconds
  (`run-3beeb40ae684`). This proves retained-state migration, not downgrade safety.
- A native acceptance and a question answer overlap the original active worker.
  The exact payload/result is queued immutably; an edit gets 409; one attributed
  continuation executes only after the source run finishes. Candidate acceptance
  and question cases passed (`run-dc29f44c99de`, `run-917768af9c48`). The baseline
  fails at the missing immutable-response assertion (`run-20242a5abc0f`), rather
  than a setup error. Earlier barrier/comment-fixture failures do not count as
  regression detection.
  The final migration/acceptance/question scripts also passed with exported CI
  artifacts (`run-6af62bb8fe7e`); those reports are in `candidate-new-contracts`.
- Actual ACP permission requests exposed the existing `read-only` alias widening
  into `approve-all` (`run-81cf5817ff9b`). The adapter now maps published restrictive
  aliases to `approve-reads` and rejects ambiguous/unknown modes before provider
  startup. Final real-host permission contracts pass on both versions, with
  authenticated provider receipts and succeeded runs (`run-6b5eb00f89a6`,
  `run-e8760b887015`). This is ACP tool-permission evidence, not proof of a
  filesystem sandbox or prevention of every possible provider-side effect.

The final native CI infrastructure suite passed all 63 tests
(`run-c8008801cb53`); the workflow YAML parsed with both version targets. The
Antigravity suite passed all 22 tests, including the permission regressions.

## Existing adapter contracts on both targets

All **14** supported positive installed-host scenarios passed:

| Target | Run | Duration | Aggregate |
| --- | --- | --- | --- |
| 2026.916.0 | `run-50d3a2ac9c2b` | 2210.951 s | `integrationAllowed: true` |
| 2026.1001.0 | `run-6bd65e0bed2f` | 2008.885 s | `integrationAllowed: true` |

These include original-session adoption/create, lost create/revision/approval
acknowledgements, typed failed-run recovery, full A→B→C native plan/PR reviews
and external standard merges, exact producer identity, deferred rejection and
historical-card withdrawal. Versioned sanitized summaries are under the private
evidence root in `baseline-native-contracts` and `candidate-native-contracts`.

Additional candidate qualifications passed:

- Actual daemon restart, native plan/PR reviews, pending user merge gate and
  separately approved dependent release: `run-b51574056b3c`, 399.292 s.
- Original-session required-PR recovery plus actual Git conflict repair,
  preserved review cards, pending-gate restart, external user merge and dependent
  release: `run-150cab7cdc0c`, 250.963 s; one required-PR message and zero observer
  writes after execution begins.
- Scheduler admission hold/reload boundary: `run-d13de74d62ae`.
- No-PR confirmation and exact failed-run typed recovery: `run-967ad71ff3d2`.
- Authoritative queued ancestry/board recovery: `run-b8a4013e0b3c`.

## Automated release gate

CI now runs the complete native-contract job for both pinned versions with
`fail-fast: false`, including its existing compiled negative controls and restored
full positives. Migration and queued-response cases are mandatory on the
candidate; actual external ACP permissions are mandatory on both versions.
Sanitized artifacts are version-separated. Missing reports, wrong versions,
timeouts and setup failures cannot become successful integration evidence.

The local results above do not claim a completed run of every daemon variant or
compiled negative control in the expanded CI matrix, real paid-provider coverage,
or compatibility after changing the adapter SDK version. The new CI matrix must
pass before using it as full automated release approval. The production permission
fix is built and isolated-host tested; loading it into the live process still
requires the normal journaled reload.
