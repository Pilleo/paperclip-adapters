---
title: "Delegate Jules session admission to provider acceptance"
severity: "HIGH"
status: "open"
priority: high
dependencies: []
component: "core"
orchestrator_managed: true
autonomy: "autonomous"
has_side_effects: true
target_modules:
  - "packages/orchestrator"
target_files:
  - "packages/orchestrator/src/server/execute.ts"
target_symbols:
  - "executeAllProjects"
open_questions: false

paperclip_issue_id: "2c68bec3-e032-42f4-a6b0-ae61eae665ff"
paperclip_identifier: "MAZ-1437"
---

# 🟡 [Severity: HIGH]: Delegate Jules session admission to provider acceptance

**Context:**
The current company-wide fresh-session budget is split across runnable projects. With five projects and a budget of three, a ready task can receive a zero allocation even when Jules is healthy and can queue it. This prevents task-start approval and session creation. Jules exposes session state but no authoritative numeric capacity; successful POST /sessions and HTTP 429 Retry-After are the provider authority.

**Needed:**
1. Write a failing multi-project scheduler regression proving that a ready task is
   offered to the Jules worker even when its project would receive a zero share
   under the old local split.
2. Remove the per-project Jules session allocation that turns a company-wide
   limit into zero local capacity. Existing Jules sessions must never be used as
   a local admission count.
3. Let a successful provider session creation, including a provider-queued
   session, be the admission success signal. Only an actual provider HTTP 429
   may pause fresh Jules starts.
4. Persist and honor a provider-scoped `Retry-After` cooldown. A cooldown must
   suppress only fresh session creation; it must not stop polling or resuming
   already-owned Jules sessions, Vibe work, reviews, or other providers.
5. Expose the admission decision in the orchestrator heartbeat summary so an
   operator can distinguish provider cooldown from a task/dependency conflict.

**TDD requirements:**
1. Add a parameterized test over at least five projects and a lower historical
   local budget, proving all otherwise-runnable projects retain a positive
   Jules offer opportunity rather than receiving an artificial zero share.
2. Add state-transition tests for: provider acceptance, queued acceptance, 429
   with `Retry-After`, 429 without a retry header, cooldown elapsed, and a
   concurrent active Jules session. Assert that only the 429 cases block fresh
   creation and that active-session polling continues in every case.
3. Run each new test red before implementation, then green after the smallest
   production change. Run the full orchestrator suite and workspace build
   afterward.
4. Add or extend the disposable Paperclip lifecycle E2E harness to prove a
   ready issue reaches its normal start-approval/session-creation path without
   requiring a manually increased project allocation. The harness must never
   call real Jules or GitHub.

**Acceptance criteria:**
- With more runnable projects than the historical `maxNewJulesSessionsPerHeartbeat`,
  no project is silently denied the ability to offer an eligible task to Jules.
- A provider-accepted session is handed to Jules, which owns queueing and
  concurrency thereafter.
- A real Jules 429 is visible, deduplicated, and respected until its provider
  deadline; no other inferred local quota blocks work.
- Existing provider continuations remain live during a fresh-session cooldown.
- MAZ-1434 can reach its normal Paperclip task-start gate and create a fresh
  Jules session without reusing MAZ-1158 / PR #8.
- Focused tests, full orchestrator tests, the lifecycle E2E, and the repository
  build pass without credentials or external provider calls.

**Non-goals:**
- Do not infer or invent a numeric Jules account quota from listed sessions.
- Do not fix MAZ-1434's implementation locally, modify PR #8, or reuse any
  prior Jules session.

---
<!-- id: issue-20260913-114745-102-delegate-jules-session-admission-to-provider-accep  file: issue-20260913-114745-102-delegate-jules-session-admission-to-provider-accep.md -->
