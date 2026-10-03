# Adapter-owned required-PR recovery

## Live failure and root cause

MAZ-1637 (`b1fa25f6-b612-405b-9908-06b5f0ab89c8`) had its revised native plan approved, but original Jules session `18392154847098533945` completed without a PR. The deployed adapter persisted a generic completion-confirmation card instead of continuing the required work.

The earlier `961fb53` fix repaired cancelled/reissued no-PR confirmation cards. The continuation implementation remained in the pilot-only operator tool `stress-campaign-no-pr-followup.ts`; the Jules runtime never invoked it. The installed-host recovery contract checked card reissue and failed-run settlement, not automatic delivery of the missing PR. This was a runtime/coverage gap, not a stale deployment or a missing user authorization.

## Correction

- Detect the explicit task obligation to create/open/publish exactly one PR from the user's task contract.
- Before falling into generic no-PR completion, execute one adapter-owned continuation on the same provider session.
- Persist its lifecycle effect before the provider POST. A started/uncertain effect is reconciled through the exact provider message echo, never blindly replayed.
- Handle existing pending no-PR confirmations through the same path, withdrawing the obsolete card after acknowledged continuation and retaining the original checkpoint.
- Require the existing native plan approval when that policy is enabled. Do not create another task/session or mark a PR-required task done without its artifact.
- Re-arm observation of an owned uncertain recovery even while its earlier human card remains pending.

## Verification

The failing execute tests reproduced both initial completion and the already-pending live-card case: no continuation was sent. They pass with the runtime correction. Real filesystem tests verify intent-before-send, accepted-but-lost acknowledgement across reload without replay, and no send after persistence failure. Existing generic no-PR completion behaviour remains covered.

`--initial-no-pr` on the real-daemon contract passed in **242.946 seconds** (`run-b771f26ce584`). The external provider initially completes with no PR; the actual Jules adapter sends exactly one original-session continuation. The same session then publishes the PR. The full workflow continues through native reviews, conflict/review continuity, pending-gate restart, actual user merge and separately approved dependent release, with zero observation-driver writes. CI now requires this boundary.

The correction was committed as `8b95d5d`; mandatory commit hooks built all adapter workspaces and passed their test suites (`run-22e1ab5a23a4`).

## Live deployment and recovery

The journaled all-company native drain/reload passed (`run-210c18d0c797`). Its owner-only journal is `/tmp/paperclip-required-pr-reload-Qjc7Vk/receipts.jsonl`. The drain began at `2026-10-03T03:13:11.770Z`, the replacement loaded orchestrator and Jules `dist/index.js`, and post-reload reconciliation `3df03a3c-2f3c-4f19-a790-7d6ffc070b4c` succeeded at `2026-10-03T03:25:44.197Z`.

- Before reload, the original provider session was `COMPLETED` with no required-PR message echo (`run-05a406c64138`).
- Normal adapter run `6f646d63-9186-48a2-82d7-a0679aa00e92` succeeded. Jules recorded the continuation at `2026-10-03T03:22:53.363318359Z`, resumed work, and completed it at `2026-10-03T03:25:37.082716Z` (`run-540408f4332d`).
- The durable checkpoint retains original session `18392154847098533945` and its native plan approval. It contains one confirmed `send_provider_message` effect, `jules:required-pr-continuation:b1fa25f6-b612-405b-9908-06b5f0ab89c8:18392154847098533945:v1` (`run-237848995cba`).
- The obsolete no-PR confirmation `7180abf5-89eb-4b7a-9832-d63fb22dc13d` is cancelled. The same task/session published and registered [PR #13](https://github.com/Pilleo/paperclip-adapters-e2e-20260923-vanilla-review/pull/13), head `83e212069631c5e2a24760c0bc26bb78e0f746ec`; `prRegisteredOnBoard` is true.
- Both native PR reviews approved that exact head, with succeeded runs: strong card `aa0c80a3-8615-426f-8be0-13c918b8f407` / run `f0bbb972-7874-4c8f-8cb3-2a04523dfd7f`, and Luna card `d33545d2-d6c7-49da-8dc4-ab7da194126d` / run `0bdc47e8-a5c3-40ad-9343-b9949e3d90c3`.

No operator provider message, replacement source task/session, rescue wake, or forced source/product status repair was used.

## Campaign checkpoint

The GET-only strict campaign observation (`run-d7457a4d2154`) reported `awaiting_user_merge`, with 2 original tasks done, 6 in review, and 12 todo. PRs #8 and #9 are merged; PRs #10–#15 each have two succeeded exact-head native approvals and pending user merge gates (`run-65b64baeed6d`). Shared sibling task 04 remains todo, and downstream fan-ins remain queued. This is a pending human checkpoint, not final acceptance of the 20-task campaign.

Snapshot: `/tmp/paperclip-required-pr-reload-Qjc7Vk/campaign-after-reload/snapshot-0001.json`. The required backlog check still reports the same ten historical plan-frontmatter errors (`run-2ca03e3f027b`).
