---
title: Verified disposable flow recovery
status: in_progress
document_type: execution_plan
base_revision: ae92c676deea865c156ae9842e7bf0e22307dc5b
---

# Verified Disposable Flow Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inline; do not delegate work unless the user explicitly requests it.

**Goal:** Establish a reproducible last-known-good boundary, fix only demonstrated failures, and prove the live Jules → Luna → Gemini → Jules → PR → merge → dependent A/B/C flow without breaking existing runs.

**Architecture:** Treat host API responsiveness and Jules's approval semantics as separate prerequisites. Preserve the stable-parent child-review protocol, all current durable state, and the unmodified Paperclip host. Make each proposed adapter change pass a failing regression first, then an isolated real-host contract, then a bounded live acceptance run; a passing unit test is never a substitute for the last gate.

**Tech Stack:** pnpm, TypeScript, Vitest, Paperclip `2026.916.0`, real PostgreSQL, Jules REST, Luna `gpt-5.6-luna`, Gemini `gemini-3.8-flash-low`, GitHub CLI.

**Spec:** `docs/superpowers/plans/2026-09-27-jules-approval-boundary-recovery.md`, `docs/superpowers/evidence/2026-09-27-jules-plan-approval.md`, `docs/superpowers/evidence/2026-09-27-gemini-native-review.md`, and `docs/superpowers/evidence/2026-09-27-paperclip-api-stalls.md`.

## Global Constraints

- The workspace contains extensive uncommitted work; record a scoped diff before editing, do not reset/rebase/stage unrelated files, and do not assume an earlier commit or run proved the full flow.
- Paperclip `2026.916.0` remains unpatched. Do not change the live PostgreSQL configuration, forge review decisions, silently bypass Jules approval, blindly create provider sessions, or retry a failed native reviewer run.
- Use only addressed native Paperclip verdict cards. Keep MAZ-1578, MAZ-1559, MAZ-1562, and their recovery evidence intact. Reuse disposable project `d53718c7-90c3-462b-b8bb-4ff7d54fa37e`.
- A service restart is allowed only after querying native run state and confirming **no active orchestrator, Jules, Luna, or Gemini run**. An active run means defer reload; use an isolated contract host meanwhile. Confirm the server loads the affected `dist/index.js` and observe a reconciliation heartbeat after an eventual idle-boundary reload.
- Never post a PR-thread review or squash merge; any merge uses `gh pr merge --merge`. Protect `.ENV` and database credentials; record only allowlisted evidence.

## File Ownership and Acceptance Ledger

| Area | Files | Current evidence, not a success claim |
|---|---|---|
| Host/API | `packages/orchestrator/src/core/github-sync.ts`, `packages/orchestrator/src/core/jules-plan-policy.ts`, `packages/orchestrator/src/server/execute.ts`; matching `test/github-sync.test.ts`, `test/jules-plan-policy.test.ts` | Removed-checkout `gh ENOENT` and redundant Jules PATCH have focused regressions; API timeouts persist. |
| Host evidence | `docs/superpowers/evidence/2026-09-27-paperclip-api-stalls.md` | `heartbeat_runs` full-row SELECTs coincide with pool saturation; the PostgreSQL activity text ends before the predicate, so caller/cause is unknown. |
| Provider gate | `packages/jules/src/server/plan-provider-decision.ts`, `provider-create-reconciliation.ts`, `execute.ts`; `docs/superpowers/evidence/2026-09-27-jules-plan-approval.md` | Two direct sessions became terminal with no approval; the provider API documents `approvePlan` for an actionable plan, and a typed rejection has already reopened the same session once. Feedback is optional diagnostic correspondence, never an execution prerequisite. |
| Reviewer transport | `packages/orchestrator/test/contract/native-child-plan-contract.mjs`; `docs/superpowers/evidence/2026-09-27-gemini-native-review.md` | Real Gemini typed verdict passed in an isolated host, not the live chain. |
| Live canary | MAZ-1578 `0b093375-44f9-422b-90e8-c3ce23b62b19`, Jules session `6533218485037147595` | Parent is blocked; Jules session is terminal. No live A/B/C completion has been proved. |

---

### Task 1: Freeze a truthful baseline and identify the failure boundary

**Files:** Update `docs/superpowers/evidence/2026-09-27-paperclip-api-stalls.md`; read only the API, native run records, and service journal.

- [x] Record the currently loaded adapter `dist/index.js` path, current scoped source diff, native run IDs/statuses and timestamps, and MAZ-1578 status. The previous orchestrator run `5a28e4a7-8f8c-403f-95ca-8d162ded45c3` failed with `process_lost` after our restart; distinguish that error from subsequent successful ticks.
- [x] Reproduce **both** endpoints with bounded, low-rate requests: `GET /api/health` and `GET /api/companies/8f4ef932-d769-43b2-981a-d273ed715162/issues?projectId=d53718c7-90c3-462b-b8bb-4ff7d54fa37e&limit=100`. Record TCP connect, time to first byte, response status, project/run attribution, and timeouts. Do not treat an occasional fast health probe as recovery.

  ```sh
  curl -sS -o /dev/null --max-time 5 -w 'health http=%{http_code} connect=%{time_connect} first_byte=%{time_starttransfer} total=%{time_total}\n' http://127.0.0.1:3100/api/health
  curl -sS -o /dev/null --max-time 12 -w 'issues http=%{http_code} connect=%{time_connect} first_byte=%{time_starttransfer} total=%{time_total}\n' 'http://127.0.0.1:3100/api/companies/8f4ef932-d769-43b2-981a-d273ed715162/issues?projectId=d53718c7-90c3-462b-b8bb-4ff7d54fa37e&limit=100'
  ```
- [x] During the *same* slow interval, take read-only `pg_stat_activity` snapshots (`pid`, `state`, query age, wait event, sanitized relation names) with a separate connection and `SET TRANSACTION READ ONLY`. Keep connection/query count bounded. Do not print SQL literals or credentials.
- [ ] For the repeated full-row `heartbeat_runs` query, determine its **actual caller and predicate** in a disposable contract host or via bounded application request tracing; the live PostgreSQL query text truncates before `FROM/WHERE` and `query_id` is null. Check whether the caller is our adapter, a native Paperclip route/job, or other traffic **before** assigning responsibility. Capture one diagnostic with the correlated host run and request IDs. No host patch to “see what happens.”
- [x] Record a pass/fail baseline table for each boundary: API request, orchestrator tick, Jules approval, typed Luna verdict, typed Gemini verdict, same-session provider mutation, PR, merge, and A/B/C. Mark unobserved steps **unverified**, never green.

**Gate:** If the failing request cannot be attributed, stop code changes to the API path. The deliverable is a sanitized, reproducible incident record and exact missing observation, not a speculative fix.

### Task 2: Correct only the attributed host failure

**Files:** Modify only the proven caller's module under `packages/orchestrator/src/core/` or `packages/orchestrator/src/server/execute.ts` and its corresponding `packages/orchestrator/test/*.test.ts`; update the API evidence file. Native-host defects stay in an external incident report, not a patch to installed Paperclip.

- [x] For an adapter-owned defect, write a regression reproducing the **same request/run outcome**, not merely a helper's return value. The actual failing test observed 18 simultaneous issue-detail GETs from one tick; another red test demonstrated a silent detail-fetch failure.
- [x] Run the focused regression before editing source and record the expected failure. Run `./scripts/adkw doctor` and `./scripts/adkw blast-radius executeProject` before changing `server/execute.ts`.
- [x] Apply the smallest correction: four concurrent issue-detail reads, stable issue order and selection, and fail-closed behavior for incomplete detail reads. Existing native PR-review tests cover the other path.
- [x] Run `pnpm --filter @pilleo/paperclip-orchestrator-adapter test`, `pnpm --filter @pilleo/paperclip-orchestrator-adapter build`, and `pnpm test:contract:child-plan-review --require-safe` against real disposable PostgreSQL. Gemini transport was not changed.
- [x] Reload **at an idle boundary** and check the package `dist/index.js` load record. Two new native orchestrator runs succeeded; 15 health/project-issues probe pairs spanning both runs all returned HTTP 200 within the five/twelve-second limits. No managed reviewer/Jules run failed and MAZ-1578 stayed blocked and Jules-owned. This is host-gate evidence only, not Jules or A/B/C acceptance.

**Gate:** A suspected native Paperclip query with no adapter-owned trigger cannot be “fixed” by suppressing errors in the adapter; stop this task and file the exact upstream reproduction while continuing independent provider qualification.

### Task 3: Qualify an actionable Jules plan without provider feedback

**Files:** Update `docs/superpowers/evidence/2026-09-27-jules-plan-approval.md`; change `packages/jules/src/server/plan-provider-decision.ts` and `test/plan-provider-decision.test.ts` only if new evidence proves a different transition.

- [x] Read the existing MAZ-1578 provider session and all activity pages and inspect the parent-scoped children. The provider is `COMPLETED` with only the original/revised plan and one already-delivered typed rejection; the only child is the earlier MAZ-1581 Luna rejection. No new provider mutation was made and the hold remains. A current-revision typed reviewer card/effect is absent.
- [ ] Use the documented `sessions.approvePlan` only after both typed verdicts address the **same** current revision and the provider is still `AWAITING_PLAN_APPROVAL`. If that state has passed, do not send approval; a `COMPLETED` session with no output and a fresh, typed **reject** can accept one journaled same-session `sendMessage` revision request, as already demonstrated. Never replay the previously delivered rejection.
- [ ] Write a failing Jules adapter regression for any newly observed wrong transition, implement only its verified correction, and run the affected Jules tests. If no current-revision typed verdict or actionable session exists, report that exact missing prerequisite and keep the hold. Do not create a replacement provider session or manufacture an approval merely because an earlier plan expired.

**Gate:** A recorded, attributable approval attempt of the current typed-approved revision while the exact session is actionable—or a documented supported continuation of that same identity—is required before releasing the live plan-review hold. Jules Feedback is optional, not a gate. A terminal session with only `planGenerated` activity fails this gate.

### Task 4: One scoped live end-to-end acceptance, then report

**Files:** `packages/orchestrator/test/contract/native-child-plan-contract.mjs` (only if contract assertions need strengthening); append observed evidence to `docs/superpowers/evidence/2026-09-27-jules-plan-approval.md` and the acceptance ledger in this plan.

- [ ] Check Tasks 2 and 3 gates, all active run statuses, the existing MAZ-1578 recovery action and its addressed child cards. Recover the **same** parent/session only through Paperclip's typed, evidence-backed recovery path when actionable; do not clear holds or duplicate wakes to obtain a green result. If the old terminal session cannot be recovered under the supported contract, obtain authorization for **one** bounded replacement task in the same disposable project, with a recorded old/new session mapping.
- [ ] Capture one immutable plan revision, Luna's addressed typed verdict, Gemini's separately attributed typed verdict, the recorded Jules `approvePlan` effect on **that** revision, provider acknowledgement, the PR URL/head, CI/review decision, standard merge commit, and A→B→C dependency releases. Ensure parent ownership stays Jules and no reviewer card is replaced while its reviewer run is active.
- [ ] Run appropriate focused packages' tests, `pnpm build`, the authenticated host contracts, `git diff --check`, and `./scripts/adkw check-backlog`. Report pre-existing backlog validation errors separately; do not silently claim that check passed.
- [ ] Publish a short acceptance table with timestamps and evidence IDs for every step. **Success** requires the PR merge and dependent A/B/C completion on the live disposable project with no bypassed verdict, duplicate session, or new native run failure. Otherwise identify the exact first failed boundary and stop; isolated contracts remain partial evidence only.
