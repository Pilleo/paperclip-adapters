---
title: Gemini live ACP failure and typed-card recovery
status: in_progress
document_type: execution_plan
base_revision: ae92c676deea865c156ae9842e7bf0e22307dc5b
---

# Gemini Live ACP Failure and Typed-Card Recovery Plan

> **For agentic workers:** Use `executing-plans` inline; no delegated agents. Preserve all live cards, runs, provider sessions, and pre-existing workspace changes.

**Goal:** Explain and correct live Gemini `session/new` rejection, then obtain one valid typed verdict on the existing MAZ-1584 card if Paperclip's native recovery path permits it.

**Spec:** `docs/superpowers/evidence/2026-09-27-jules-plan-approval.md` and `docs/superpowers/plans/2026-09-27-verified-disposable-flow-recovery.md`.

**Current identities:** Parent MAZ-1582 `8d57b0c4-f2d9-4f1d-a5ca-9929a99d5ef7`, child MAZ-1584 `712a1201-f6cf-4551-9d02-9fc8c036f70e`, pending native card `65282984-da31-40b2-8809-df90e837faf2`, failed Gemini run `33cf185a-7c44-4f2e-84c4-574763dbeabe`, parent plan revision `d46c6ad2-7dad-456e-a6ca-877c86aa222c`, Jules session `6673343333232733703` (`COMPLETED`, outputless). Native recovery action is settled blocked and the run permits `inspect_run` only.

## Hard gates

- Never replay `failedRunId`, manually PATCH a blocked issue, create a replacement card, fake a Gemini verdict, or approve Jules merely because a reviewer answered. Only its one addressed typed card can carry a verdict.
- Paperclip remains unpatched. No reload during an active orchestrator, Jules, Luna, or Gemini run. Keep MAZ-1578, MAZ-1582 and the old B/C blockers intact.
- No raw ACP messages, rejected `input`, error `msg`, MCP headers, API keys, prompts, or environment values in logs. Only validation error `code`, allowlisted `loc` field names/indices, and fixed `type` values are retained.

### Task 1: Capture validation shape safely

**Files:** `packages/antigravity/src/server/acp-session-diagnostic.ts`, `src/server/index.ts`, `tests/acp-session-diagnostic.test.ts`, `tests/execute.test.ts`, `packages/antigravity/package.json`, `pnpm-lock.yaml`.

- [x] Verify AGY emits JSON-RPC `-32602` with `data.errors[*].{loc,type,msg,input,url}` for malformed `session/new`; the installed ACP SDK retains the structured `RequestError`, while adapter-utils discards its `.data` when reporting a run failure.
- [x] Write red tests proving diagnostics omit rejected values; implement a wrapper around the documented `createAcpxEngineExecutor({ createRuntime })` seam that catches `ensureSession`, reports only allowlisted field paths/types, and rethrows the original error. Depend explicitly on `acpx@0.12.0`.
- [x] Run the Antigravity suite/build and authenticated Gemini contract against unpatched Paperclip and real disposable PostgreSQL. The positive typed-verdict contract passed.
- [x] Reload only in a measured idle interval, confirm Antigravity `dist/index.js` loads, and let orchestrator reconcile managed Gemini configuration. No live Gemini retry has been issued yet.

### Task 2: Qualify exactly one existing-card retry

**Files to inspect:** `packages/orchestrator/src/core/native-review-recovery-state.ts`, `native-review-recovery.ts`, `packages/orchestrator/test/contract/native-plan-concurrency.mjs`, installed Paperclip `routes/agents.js` (read-only).

- [x] Read the card and reviewer run history: one pending card with target revision `d46c6ad2-7dad-456e-a6ca-877c86aa222c`, no active Gemini run, and an `ensure_session` failure before any model turn or verdict.
- [x] The first isolated control showed that a generic same-card `heartbeat.wakeup` is **refused** after a pre-turn terminal run (`execution_reconciliation_required`). A second isolated control proved the supported board-typed `/issues/:id/recovery-actions/resolve` path with `executionReconciliation` and durable continuation delivery: one new reviewer run, the original card answered, real PostgreSQL, and no replay of the failed run.
- [x] Use only the host's typed recovery action with an allowlisted exact run/card/revision check and a journaled intent. No generic reviewer wake or replacement card was issued.

### Task 3: Attribute error, correct one parameter, verify

**Files:** Only the module proven responsible by `loc` in `packages/antigravity/src/server/` or its managed fleet configuration under `packages/orchestrator/src/core/fleet-manager.ts`, plus focused tests.

- [x] A journaled native typed restore of the original card exposed `session/new` validation `name` / `string_pattern_mismatch`. A direct AGY control reproduced it with host MCP name `Paperclip projects`; the normalized `paperclip_projects` succeeded. Red unit tests preceded the adapter-only MCP-name correction, followed by tests/build and a real host-like Gemini typed-verdict contract.
- [x] A second run reached the model but could not start its configured `codegraph` MCP command on Paperclip's sanitized PATH. After containing the repeated no-verdict wakes at an idle boundary, a red test preceded the adapter PATH correction. Rebuild, Antigravity suite, real Gemini contract and idle reload passed. A journaled typed `stranded_assigned_issue` restore produced one native Gemini run `2abfc89b-18d6-45ed-ae8c-0b6d4d2933ff`; it answered the **original** card with typed `approve` on revision `d46c6ad2-7dad-456e-a6ca-877c86aa222c` and succeeded.
- [x] Recheck the exact live card, bound new run, parent revision, and Jules activity. The original card was answered by succeeded Gemini run `2abfc89b-18d6-45ed-ae8c-0b6d4d2933ff` on revision `d46c6ad2-7dad-456e-a6ca-877c86aa222c`. A **single journaled** approval request after both exact typed verdicts was accepted on the same formerly outputless `COMPLETED` Jules session; provider activity now includes approval, progress, completion, and PR #1. MAZ-1582 remains blocked, so board PR reconciliation and merge are **not** qualified by this provider-only result.

**Stop condition:** No supported existing-card wake, an uncertain wake outcome, or a repeat failure with no safely attributable parameter leaves both the card and parent held. Preserve the one-attempt receipt; no second mutation to chase a green result.
