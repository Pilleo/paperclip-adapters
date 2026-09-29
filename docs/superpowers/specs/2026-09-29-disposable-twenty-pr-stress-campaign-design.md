---
title: Disposable twenty-PR dependency stress campaign
status: approved_design
document_type: design_specification
date: 2026-09-29
---

# Disposable twenty-PR dependency stress campaign

## Purpose and boundary

Exercise the live, already-tested Paperclip adapters with 20 small, meaningful PR-producing issues in a single DAG. Verify unblocked parallel scheduling, multi-parent dependency gates, declared-file conflict exclusion, Jules session continuity, independent native plan and PR reviews, user-only merge, and final reconciliation before further compiler-enforced refactors. The user approved a dedicated project and is willing to merge approximately 20 PRs. The campaign records observations; a failed boundary remains a failed result until it is diagnosed through its supported native path.

The prior `<!-- paperclip-adapters:e2e-project:v2 -->` rule allowed only one replacement canary project and forbade new canary runs while marked historical tasks remained nonterminal. At design time, that project `d53718c7-90c3-462b-b8bb-4ff7d54fa37e` had 11 marked nonterminal tasks. The user's explicit choice **B** authorizes one *additional*, distinctly marked stress-campaign project in the same Mazewall company, not a second v2 canary project. Do not change, cancel, approve, or reuse those 11 old issues to prepare this campaign. The campaign project is marked `<!-- paperclip-adapters:stress-project:v1 -->`; each issue carries one shared `<!-- paperclip-adapters:stress-run:<run-key> -->` marker, and at most one such campaign may be active. Reuse the existing disposable repository `Pilleo/paperclip-adapters-e2e-20260923-vanilla-review`, branch `master`, through a **separate project-owned git_repo checkout**, verified by `assertProjectBackedGitWorkspace`. No new company or repository is needed.

## Graph and task contracts

Create the issues in numeric order, initially with status `backlog` so a timer tick cannot dispatch a partially created graph. `blockedByIssueIds` at POST must contain the native Paperclip IDs of the listed predecessors. All six roots have an empty native blocker list. Each issue has a unique run-qualified title, canonical first-block YAML with `orchestrator_managed: true`, an explicit project ID, `target_files` listing its implementation and test files, `assigneeAdapterOverrides.adapterConfig.ciPolicy: skip` (the disposable repository has no Actions workflow), a focused acceptance command `node --test <run-qualified-test-file>`, and the same run marker. Prior A/B/C files must not be modified. Define the implementations in CommonJS so the existing `node:test` fixture is usable on the disposable repository. Every task asks its provider to preserve existing exports and tests.

| Task | Native predecessors | Focused deliverable / graph case |
| --- | --- | --- |
| 01 | none | Export `increment(n)` and test positive, zero, negative and invalid input; independent root. |
| 02 | none | Export `cleanText(value)` that trims whitespace and rejects non-strings; independent root. |
| 03 | none | Add `safeInt(value)` to one run-qualified `numbers.js`, accepting integer strings and returning `null` for fractions/invalid input; first competing root. |
| 04 | none | Add `safeDecimal(value)` to **that same** `numbers.js`, accepting finite decimal strings and returning `null` for invalid input; second competing root. Its own test file is distinct from 03's. No native dependency between 03 and 04: the declared shared path must keep them from running simultaneously. |
| 05 | none | Export `uniqueSorted(values)` for finite-number arrays, with empty/duplicate/invalid tests; independent root. |
| 06 | none | Export `normalizeKey(value)` for a trimmed lowercase string, rejecting non-strings; independent root. |
| 07 | 01 | Export `doubleIncrement(n)` using 01's module; verify its predecessor is merged before this provider begins. |
| 08 | 07 | Export `clampDoubleIncrement(n, min, max)` using 07; test valid and invalid bounds. |
| 09 | 08 | Export `isEvenClamped(n, min, max)` using 08; test even/odd outputs. |
| 10 | 09 | Export `describeParity(n, min, max)` using 09; terminate the five-task chain. |
| 11 | 02 | Export `lowerCleanText(value)` using 02; first diamond arm. |
| 12 | 02 | Export `wordCount(value)` using 02; second diamond arm, distinct target files from 11. |
| 13 | 11, 12 | Export `textSummary(value)` using both arm exports; diamond join waits for both merges. |
| 14 | 03, 04 | Export `parseNumberPair(intText, decimalText)` using both exports in their shared module; two-prerequisite gate. |
| 15 | 14 | Export `sumNumberPair(intText, decimalText)` using 14; fan-out arm one. |
| 16 | 14 | Export `multiplyNumberPair(intText, decimalText)` using 14; fan-out arm two, separate file. |
| 17 | 05 | Export `countUnique(values)` using 05; independent sibling successor. |
| 18 | 05 | Export `firstUnique(values)` using 05; another independent sibling successor. |
| 19 | 06 | Export `hyphenKey(value)` using 06; second chain. |
| 20 | 19 | Export `keyLength(value)` using 19; second chain terminal. |

Task-specific implementation and test file paths are run-qualified and distinct except for the **intentional** 03/04 `numbers.js` declaration. Task 14 imports the file as it exists after both merges. 03 and 04 must add rather than replace exports, so either merge order produces both functions. Assert 03 and 04 are never simultaneously assigned/executing, then that the held one progresses once the first is merged. Do not manufacture unrelated Git conflicts, reviewer rejections, provider failures, or stale PR heads to meet case counts; those are independently covered by isolated native-host contracts.

Graph shorthand:

```text
01 -> 07 -> 08 -> 09 -> 10
02 -> 11,12 -> 13
03,04 -> 14 -> 15,16
05 -> 17,18
06 -> 19 -> 20
```

## Components and flow

1. **Manifest and preflight:** Keep the 20 task descriptions, predecessor keys, target paths, test expectations and marker in a deterministic manifest. A pure validator rejects unknown keys, cycles, duplicate targets outside the declared 03/04 pair, missing acceptance tests and non-topological creation order. Unit-test this validator before any board mutation. A dry-run prints the graph and descriptions and makes no network writes. Confirm the installed host version, package build and existing green unit/type/native-host contracts; wait for all companies to be idle before restarting Paperclip to load newly built adapters, then confirm `dist/index.js` startup and one orchestrator configuration-reconciliation heartbeat. Confirm the GitHub default branch, project checkout/repo/ref, access, and existing project identity read-only.
2. **Provision exactly one campaign project:** Use a run-qualified name and the distinct `stress-project:v1` marker. Before POST, look for that run's project marker; on unknown response, GET again and halt if identity remains uncertain. Configure a primary `git_repo` workspace at the existing SSH remote/default `master` with its own managed checkout; verify `assertProjectBackedGitWorkspace` and a different canonical path from the v2 project. Never create another project just because a previous response was lost. Record a private intent and public-safe identity digest, not secrets.
3. **Create and verify before execution:** POST 01–20 as `backlog` in order with the manifest-derived native blocker IDs and one per-task journal intent. On an uncertain POST response, search the project by the **unique** run-qualified title and run marker, GET the exact issue and compare immutable task contract; never blindly retry. GET every issue detail after the batch; require exactly 20 matching managed `backlog` issues, exact `blockedBy` ID sets, declared file scopes, correct project and unique identities. Only then journal and transition the verified 20 issues to `todo`; read them back before the first intentional project-scoped orchestrator wake. Do not approve task starts or allow work while the graph is incomplete.
4. **User-start gate:** One project-scoped wake should create the task-scoped `task_start` approvals. Confirm there is one live gate per issue (or a documented already-resolved gate), and the six roots do not start before approval. The user approves all 20 task starts via the Paperclip UI/native route. The operator does not script approvals. Capacity-aware routing may queue otherwise eligible tasks; a lack of simultaneous execution is not by itself a failure.
5. **Read-only observation:** Poll bounded Paperclip issue details, run and native card endpoints, validated Jules GETs, and `gh` read-only PR/commit metadata; use pagination where needed. Persist sanitized snapshots with a monotonic sequence and timestamps under a run-specific local evidence directory, never credential-bearing payloads. Trace each original issue → session → plan revision/card/run/verdict → PR product/head → PR reviewer child/card/run/verdict → pending merge gate → user GitHub merge commit → product `merged` and issue `done`. User approves operator merge gates as they appear and alone makes each standard two-parent GitHub merge after head-bound native approvals. No GitHub thread review is a Paperclip verdict; no adapter or fixture merges a live PR.
6. **Triage and stop rules:** On a missing predecessor, early dependent start, overlapping 03/04 provider work, duplicate/ambiguous session/product/card, stale-head verdict, unexpected terminal run, provider effect with uncertain outcome, or unqualified recovery action, stop making *new* campaign mutations. Capture exact issue/run/session/card/head IDs read-only and classify the first failing boundary. Never retry a terminal run, manually PATCH an issue to `done`, auto-approve a card, hide a blocker, or replay an uncertain provider POST. If the host offers a valid native typed recovery, require exact authority, stopped run, and independently established effect outcome before using it; a failed campaign remains reported as failed even if later recovered.

## Verification and acceptance

- Offline tests: manifest shape/DAG/order/03–04 shared scope, duplicate and ambiguous POST handling, 20-task acceptance reporter, wrong-order snapshots, changed-head reviews, missing GitHub merge ancestry, terminal issues with actionable blockers, read-only operation. No mocked database calls for integration or state-machine tests; use the existing real SQLite/PostgreSQL contracts.
- Existing gates: `pnpm test`, `pnpm build`, `pnpm typecheck:invariants`, the pinned-host positive A→B→C contract and the auto-blocker recovery contract; establish a green baseline **before** the campaign and do not refactor the adapter during live observation.
- Succeed only when all 20 original tasks are `done`, each has exactly one primary PR work product verified `merged`, each recorded GitHub PR is actually merged via a standard two-parent commit whose second parent is the approved immutable head, both native PR reviewer approvals belong to addressed succeeded runs/head and plan review is traceable to the original session, all predecessor merges precede dependent provider start, and the 03/04 shared path has no overlapping execution. Check one original session/product per issue (a native retry of the **same** session must not count as a new provider session), no open actionable execution blocker on a completed issue, no stranded native approvals or duplicate child/card for the active head, and no unexpected failed run during the campaign. The report must distinguish `awaiting_user_start`, `awaiting_user_merge`, `awaiting_provider`, `invalid`, `failed`, and `passed`; timeout is not a pass.
- Changes to compiler-enforced adapter state types come **after** this measured run and its evidence review; write failing regressions for any observed bug before source changes. Keep the campaign reusable for a subsequent replay on a newly qualified fresh run/project rather than silently resetting this campaign's history.

## Handoff and explicit human actions

Before task creation the user reviews the implementation plan. During the run the user approves the 20 native task-start approvals, reviews/approves merge gates, and merges up to 20 GitHub PRs. The monitor can run unattended between those actions; it must distinguish waiting for the user from an adapter stall. A complete campaign has a sanitized per-issue evidence table and an unambiguous pass/fail verdict, with historical v2 issues left untouched.
