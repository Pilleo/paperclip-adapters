---
title: Jules approval boundary and terminal-session recovery
status: in_progress
document_type: execution_plan
base_revision: ae92c676deea865c156ae9842e7bf0e22307dc5b
---

# Jules Approval Boundary and Terminal-Session Recovery Implementation Plan

> **For agentic workers:** Use `executing-plans` to implement this plan task-by-task. Preserve existing uncommitted work. Steps use checkbox syntax for tracking.

**Goal:** Establish and enforce the Jules plan-approval contract, recover only from proven provider outcomes, and demonstrate a real Luna → Gemini → Jules → PR → merge dependency chain.

**Architecture:** Add evidence at the serialized provider-request boundary and a pure decision layer for provider state versus durable review effects. Keep the stable-parent v3 child protocol. Use a bounded provider qualification experiment before changing terminal-state behavior; polling faster is not an approval mechanism.

**Tech Stack:** TypeScript, Zod, Vitest, pnpm, authenticated vanilla Paperclip `2026.916.0`, real disposable PostgreSQL, Jules REST API, Codex Luna 5.6, Antigravity Gemini 3.8 Flash Low.

**Spec:** Requirements in this plan, derived from the user's requested provider-neutral review flow and same-project disposable test. The existing host contract is documented in `packages/orchestrator/test/contract/STABLE-CHILD-RESULTS.md`.

## Execution status (2026-09-27)

- Request evidence, durable pre-POST create intent, exact-session discovery/no-replay, and typed v3 mutation attribution are implemented. Older mutation paths still emit `unattributed:*` evidence and are **not** proof of a reviewed-plan approval.
- Both bounded direct controls completed without approval despite `requirePlanApproval: true`; `AUTO_CREATE_PR` and `AUTOMATION_MODE_UNSPECIFIED` behaved alike. See `docs/superpowers/evidence/2026-09-27-jules-plan-approval.md`.
- Pure provider-state decisions and complete v3 activity pagination are implemented. One journaled typed rejection reopened the same terminal Jules session and produced a new plan; terminal approval remains prohibited without a live, attributable effect.
- Real-host monitor callback race proof and a live Gemini typed verdict/A→B→C chain remain unverified. **Stop at the provider required-approval contract boundary; do not create another session to chase a green canary.** MAZ-1578 retains its recovery hold.

## Global constraints

- No host patches, synthetic review verdicts, silent opt-outs, or blind retries.
- Preserve parent ownership, provider session identity, addressed card identity, and immutable plan revision across restarts.
- Fast reviewer: `gpt-5.6-luna`; strong reviewer: Antigravity `gemini-3.8-flash-low`. Generic review logic must not require Codex to be installed.
- Reuse project `d53718c7-90c3-462b-b8bb-4ff7d54fa37e`. Do not create another project or silently replace a provider session.
- Keep MAZ-1559, MAZ-1562, and terminal canary evidence intact. Do not clear MAZ-1578's hold merely to get a green status.
- Real database for host contracts; mocks belong only at transport/unit boundaries. Write regressions before source changes.
- Use the existing `.agents/skills/checking-jules-sessions` helper. `.ENV` is case-sensitive, ignored, and owner-only. Keys stay in memory; never log headers, environment values, or raw request bodies.
- Build, reload at an idle boundary, confirm loaded `dist/index.js`, then allow fleet reconciliation before any live test. Do not restart into an active provider/reviewer run.
- Standard merge commits only: `gh pr merge --merge`.

## Evidence and uncertainty

Read directly from Jules during planning:

| Field | Evidence |
|---|---|
| Parent | MAZ-1578 / `0b093375-44f9-422b-90e8-c3ce23b62b19` |
| Session | `6533218485037147595` |
| Created | `2026-09-26T22:58:26.216218165Z` |
| Plan generated | `2026-09-26T22:58:58.114972Z`, five steps |
| Current state / update | `COMPLETED` / `2026-09-26T23:06:31.213919Z` |
| Returned history | One `planGenerated`; no next page; no approval or completion activity in that response |
| Outputs | Empty |
| Provider-stored prompt | Contains increment examples, CommonJS, test filename, `node --test`, and the exact issue/run marker |
| Reviewer result | MAZ-1581 has an answered Luna rejection; subsequent parent run stopped on provider-state conflict |

**Not yet established:** the exact boolean sent by the live create request; why the provider changed state; whether another process/user mutated the session; whether terminal sessions support a safe same-session revision request; whether state/activity projections are eventually consistent.

Google documents `requirePlanApproval` and `automationMode` as **input-only** session fields. Their absence in GET is not proof of a missing create flag. Source: https://developers.google.com/jules/api/reference/rest/v1alpha/sessions

Earlier claims that this is definitively an upstream timeout are hypotheses, not a diagnosis. The inactive `paperclip-jules-pr-reconciler.service` is also not proof that no other writer ran historically.

## Task 1 — Prove the exact create and mutation contract

**Files:**
- Create `packages/jules/src/server/provider-request-evidence.ts` and `packages/jules/test/provider-request-evidence.test.ts`.
- Modify `packages/jules/src/server/jules-client.ts`, `session.ts`, `execute.ts`, and `session-initializer.ts`.
- Extend `packages/jules/test/jules-client.test.ts`, `session-initializer.test.ts`, and `execute-checkpoint-restart.test.ts`.

**Interface:** one allowlisted evidence type produced immediately after request schema validation:

```ts
type ProviderRequestEvidence =
  | { kind: "create"; requestId: string; issueId: string; runId: string;
      requirePlanApproval: boolean; automationMode: string;
      source: string; baseBranch: string; promptSha256: string }
  | { kind: "mutation"; requestId: string; sessionId: string;
      method: "approve_plan" | "request_revision" | "send_message";
      effectId: string; planActivityId: string | null };
```

- [ ] Write a red transport test proving a required code-changing task serializes `requirePlanApproval: true` in the actual `/sessions` body, through both creation paths. Cover legacy `requirePlanApproval`, issue overrides, and explicit trusted opt-out; contradictory settings must not silently win.
- [ ] Test lossless task → provider prompt → plan document → card content: compare the requested behavior/test scope at each boundary. The observed prompt is correct, but that does not prove plan rendering or card details are correct.
- [ ] Persist create intent before POST, correlate its response to one session ID, and record allowlisted evidence. Cover failed response/checkpoint writes; an ambiguous create must not trigger another create automatically.
- [ ] Inventory every `approvePlan` and `sendMessage` call in `execute.ts`, including legacy paths. Require an effect identity and record safe request/response outcomes. Do not infer a mutation from a successful adapter exit.
- [ ] Test that API keys, unrelated env entries, raw prompts, bearer headers, and provider error bodies never enter evidence or errors.
- [ ] Run `pnpm --filter @pilleo/paperclip-jules-adapter exec vitest run test/provider-request-evidence.test.ts test/jules-client.test.ts test/session-initializer.test.ts test/execute-checkpoint-restart.test.ts`.

## Task 2 — One bounded experiment to identify the failing boundary

**Files:** Create `packages/jules/scripts/qualify-plan-approval.ts`, `packages/jules/test/qualify-plan-approval.test.ts`, and `docs/superpowers/evidence/2026-09-27-jules-plan-approval.md`.

**Deliverable:** a restartable experiment manifest containing session IDs and safe observations, never credentials. Store provider payloads only as allowlisted metadata; do not dump them to disk.

- [ ] Test that a rerun with an existing manifest observes the existing sessions and never POSTs another create; missing/ambiguous create receipts stop the experiment.
- [ ] Use at most two explicitly marked sessions on the existing disposable repository: (A) the production request builder/client outside Paperclip execution and (B) the actual Paperclip path with an equivalent scoped task. Both send verified `requirePlanApproval: true`. Do not approve either during the initial observation window.
- [ ] Observe state and all activity pages every 30 seconds for a bounded 12-minute window, exceeding the previously observed approximately eight-minute creation-to-completion interval. Record API update times, page completeness, plan identities, outputs, and every adapter-owned mutation.
- [ ] Audit other potential writers by action timestamps/session IDs, including external reconciliation jobs and operator actions. Do not copy service environments or secrets.
- [ ] If completion is observed, repeat GET plus full activity scan after 10 and 30 seconds. A single snapshot is insufficient evidence for recovery. This is observation, not a heartbeat retry loop.
- [ ] Classify the experiment using this decision table and record it before proceeding:

| Outcome | Required next action |
|---|---|
| Wire flag false/missing or prompt/card corrupted | Fix the proven serializer/config/rendering boundary; reproduce with one red regression. |
| Control waits; Paperclip session completes | Find and eliminate the extra writer, wrong identity, or inconsistent payload. Do not blame the provider. |
| Both complete without an approval mutation | Record a provider-contract violation and stop normal execution. Qualify same-session revision recovery separately; do not remove the approval gate. |
| Completion disappears on repeated reads | Add bounded consistency reconciliation using plan/session identity; never approve from the stale snapshot. |
| Both remain pending | Reproduce the original timing with recorded inputs; do not declare an upstream defect. |

- [ ] No third throwaway session after an inconclusive result. Preserve the manifest and report the unanswered boundary.

## Task 3 — Unify provider-state decisions around exact evidence

**Files:** Create `packages/jules/src/server/plan-provider-decision.ts` and `packages/jules/test/plan-provider-decision.test.ts`; modify `execute.ts`, `native-plan-effect-reconciler.ts`, and `lifecycle-effect-journal.ts` only where needed.

**Interfaces:** `decidePlanProviderAction` consumes current session/plan identity, provider state, history completeness, work-product evidence, exact typed verdict, and the persisted effect attempt. It returns this discriminated union, handled by an exhaustive switch:

```ts
type PlanProviderAction =
  | { kind: "wait_for_verdict" }
  | { kind: "approve_once"; effectId: string }
  | { kind: "request_revision_once"; effectId: string }
  | { kind: "observe_unknown_effect"; effectId: string }
  | { kind: "reconcile_recorded_work" }
  | { kind: "hold"; reason: "terminal_without_approval" | "identity_conflict" |
      "incomplete_history" | "unverified_progress" };
```

- [ ] Red-test `COMPLETED` with no approval effect, no approval event, and no output. Return `hold`, not approve, issue-done, new session, or infinite pending wait. Detect it before creating another review child, even when the current card is pending.
- [ ] Red-test `IN_PROGRESS` without an exact approval effect. Provider progress alone does not establish that our reviewed revision was approved.
- [ ] Red-test a lost approval response with a persisted started effect. Confirm only from evidence attributable to the same session/plan; otherwise observe without resending.
- [ ] Red-test a recorded work product after completion. Inspect the PR/branch and exact head; preserve existing review requirements rather than manufacturing missing plan approval.
- [ ] Red-test stale Luna/Gemini verdicts after a new provider plan, incomplete activity pagination, approval/rejection concurrent with a new plan, and inconsistent state snapshots.
- [ ] Replace competing ad hoc terminal branches with this decision at the v3 boundary. Keep legacy checkpoints readable; do not globally rewrite stored stage names.
- [ ] Run the decision tests plus `test/native-plan-effect-reconciler.test.ts`, `test/lifecycle-runner.test.ts`, `test/e2e-plan-presentation.test.ts`, and `test/execute-no-pr.test.ts` in the Jules workspace.

## Task 4 — Recover a rejected plan in the same session only if qualified

**Files:** Modify `packages/jules/src/server/plan-revision-request.ts`, `execute.ts`, and session codec/store fields; extend `packages/jules/test/plan-revision-request.test.ts`, `review-feedback-relay.test.ts`, and `session-lifecycle.test.ts`.

- [ ] Read current `PlanRevisionRequest` delivery logic first; it already recognizes that Jules can briefly retain an old terminal state after accepting a message. Do not replace it with a second message journal.
- [ ] In the controlled experiment only, send one journaled revision request referencing an actual typed rejection, if the documented/provider-tested operation allows a completed session to continue. Do not use an approval request to reopen a rejected plan.
- [ ] Require the same session ID, exact request marker echo or equivalent attributable receipt, and a genuinely newer plan activity before accepting recovery. A 2xx or a changed session update time alone is insufficient.
- [ ] Restart-test the gap before send, after send/before checkpoint, and after a newer plan but before card creation. A request with an unknown outcome is observed, never blindly repeated. A new plan invalidates prior approvals and starts Luna review again.
- [ ] If same-session recovery is unsupported, retain one actionable reconciliation hold with the verified reason. Any replacement session requires an explicit recorded recovery decision; no automatic endless A/B/C recreation.

## Task 5 — Make timing and host handoffs deterministic

**Files:** Modify `packages/jules/src/server/paperclip-client.ts`, `execute.ts`, `packages/common/src/child-plan-review-parent.ts`, and the existing contract fixture under `packages/orchestrator/test/contract/`.

- [ ] Keep short plan-stage polling but verify the persisted host deadline after every schedule write. Reuse earlier monitors; do not reuse a later 900-second deadline when a 60-second check was requested.
- [ ] Add a real-host race test: old monitor callback in flight while a shorter deadline is written. Prove the stale callback cannot erase the replacement or cause two owner runs. A unit test returning the desired PATCH body is not sufficient.
- [ ] Trace why the orchestrator or host introduces long monitor deadlines and fix that writer. One owner must control the current plan wait schedule.
- [ ] Measure child checkpoint → bootstrap dispatch → card created → settled bootstrap → reviewer assignment → verdict consumption. If scheduler queueing is responsible, use the host-supported issue-bound continuation with one durable owner; no manual repeated wakes or parent reassignment.
- [ ] Test paused reviewer as a dependency wait and restore exactly one existing child/card after readiness changes. Generic child recovery must not reinterpret a normal wait as failed implementation.
- [ ] Run `pnpm test:contract:child-plan-review --require-safe` on real disposable PostgreSQL. Extend the fixture with delayed callbacks, restart, and reviewer-unavailable cases instead of weakening assertions.

## Task 6 — Qualify Gemini independently, then one end-to-end chain

**Files:** Extend `packages/antigravity/tests/review-mcp.test.ts` and the authenticated child-plan contract harness; record live evidence beside the provider qualification report.

- [ ] Prove more than initialize/tools-list: actual AGY `gemini-3.8-flash-low` must load an addressed native assignment and submit its structured verdict through Paperclip. The reviewer outcome may legitimately be reject; transport failure is not a verdict.
- [ ] Exercise full MCP request/notification lifecycle, current run credentials, cancellation, process exit, and idempotent close using the real transport. Verify no Codex installation/home is needed for this reviewer.
- [ ] Run package tests with pnpm, `pnpm build`, `git diff --check`, and `./scripts/adkw check-backlog`. Report existing backlog/index failures separately; do not erase them.
- [ ] Deploy once at an idle boundary and verify exact dist loads/configuration. Freeze the canary's relevant model/adapter configuration for the run to avoid config-driven session resets.
- [ ] Reuse the existing project. After terminal evidence is accounted for, use one precisely scoped A/B/C chain with explicit acceptance criteria, declared test files, and real verification commands. Do not change an active reviewed revision's requirements under its existing card.
- [ ] Observe all of: provider-stored prompt, same session ID, exact plan activities, typed Luna and Gemini verdicts, exactly-once revision/approval effects, PR/head verification, merge approval, standard merge commit, and only then dependent task start.
- [ ] Stop on the first unexplained terminal transition, duplicate card, session replacement, authorization failure, or recovery hold. Produce a causal report; do not start another chain to hide it.

## Completion criteria

1. The premature completion has a reproduced and supported cause, not an assumed timeout.
2. Missing approval can never be inferred from `COMPLETED`, a successful adapter run, or a missing field in GET.
3. Restart and timeout recovery neither duplicate mutations nor silently replace sessions.
4. The live Gemini agent produces a real native verdict, independently of Codex.
5. One complete A → B → C run passes plan review, PR review, and merge ordering without manual status repair.
6. If the external provider violates the required-approval contract and no safe continuation exists, the result is explicitly **blocked on provider contract**, not "fixed".

## Current recovery boundary

MAZ-1578 is held by recovery action `c21d8b8a-de32-4b19-955d-eee5891ed28d`, from run `47a182be-f606-4f6e-9733-d729823aca8d`. Re-read both before any mutation; these identifiers are evidence, not permission to replay. This planning task makes no live changes and creates no provider sessions.
