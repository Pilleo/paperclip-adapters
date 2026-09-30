---
title: Durable Jules PR handoff without continuation starvation
status: proposed
date: 2026-09-30
---

# Durable Jules PR handoff

## Goal

Let a terminal Jules session's verified PR enter native review automatically, without repeated provider continuations or cancellation of an active worker.

## Observed failure

MAZ-1623's original Jules session `9473602080744226872` opened PR #7 at `0a69c3efcdb9cce173e72273b1083aa131be16f9`. Paperclip registered product `d7b38d24-9293-4fd9-a869-252253bf9b6f`. After registration, 27 issue-scoped runs were observed by 01:19 UTC: 26 succeeded, one running. They repeatedly return `issueStatus: in_review`, although `moveIssueToReview` only registers a product and the host issue remains Jules-owned `in_progress`. The orchestrator defers its owner-release PATCH whenever a newer live run retains authority.

The installed host's `recovery/service.js` treats an assigned `in_progress` issue with a productive terminal run and no durable wait as needing continuation. Re-registering work and recent visible progress keep that retry path eligible. `hasPersistedDurableWaitPath` recognizes `issue.monitorNextCheckAt`; the adapter currently clears that monitor before awaiting orchestrator handoff. This leaves a scheduling gap in which host recovery competes with review routing.

## Proposed protocol

1. Register and verify the exact PR product/head while retaining the original Jules session.
2. Before returning from the terminal worker, persist a bounded native Jules monitor describing **awaiting orchestrator PR handoff**, not active provider execution. Use the existing host monitor transport; no private timers or fabricated review cards.
3. Return honest evidence: provider `jules`, original session, provider state `COMPLETED`, PR URL/head, actual issue status, and `handoffPending: true`. Do not claim the host issue entered review before it did.
4. The orchestrator hydrates the exact product-producing run. A succeeded, same-session terminal producer may make the PR review-eligible despite its bounded handoff monitor. A pending flag alone does not prove completion.
5. Keep fresh issue/run guards. Never clear ownership when an issue-scoped run is queued/running, an executionBlocker exists, the PR/head changed, or completion evidence is missing. A settled later run must not be mistaken for an active run solely because an old executionRunId pointer differs from the producer: hydrate that referenced run and validate its scope/status before deciding.
6. Once the worker is terminal, the orchestrator removes the monitor and releases ownership in the existing four-field native-review cleanup PATCH, verifies the readback, and routes the existing native reviewer-child protocol.
7. If the orchestrator does not act before the monitor deadline, the same Jules session is polled once and the bounded handoff wait is renewed after re-verifying PR/head. No new provider session, sendMessage, approvePlan, issue comment, or duplicate product is authorized by this wait.

The existing `serviceName: jules` monitor transport is sufficient if the installed-host contract proves this lifecycle. Keep a small adapter-owned handoff checkpoint only if needed to distinguish completion/handoff waiting from rejection, CI remediation and provider polling. The checkpoint must be head-bound and superseded on fresh provider work or typed rejection; do not encode canonical configuration or secrets in metadata.

## Constraints

- Installed host is Paperclip `2026.916.0`; qualify using real isolated PostgreSQL and unmodified host code.
- Work inline on `master`; no worktrees or subagents.
- User alone merges live GitHub PRs. No GitHub-thread reviews or invented Paperclip verdicts.
- Preserve MAZ-1624's queued run and rejected PR #6; no cancellation or blind replay to create a handoff gap.
- Keep no-PR completion, native plan waits, questions, red CI and rejected PR heads on their existing typed paths.
- Native monitor writes fail closed and verify their receipts; failure cannot be reported as successful handoff.
- Before reload, use `/api/companies/:id/live-runs?minCount=0&limit=50` for all six companies and detect saturation. Distinguish queued work from running processes; record any preserved queued run explicitly.

## Acceptance

An isolated real-host recovery sweep after a terminal PR registration does not enqueue `issue_continuation_needed`; the next normal orchestrator heartbeat releases the terminal producer and creates one exact-head native Luna reviewer card. A deliberately held later Jules run remains uncancelled and prevents ownership release until it finishes. A delayed orchestrator results in bounded monitor polling, not per-tick continuations. The original session is preserved throughout; no provider POST occurs solely because the PR is awaiting review.

Live acceptance is PR #7 entering the existing addressed native review path, with unchanged PR #6 and no merges. A valid review rejection is an outcome, not a transport failure. Stop at a new bug or terminal reviewer failure and retain exact card/run evidence.
