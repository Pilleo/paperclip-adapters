# 🎛️ @pilleo/paperclip-orchestrator-adapter

Deterministic, multi-lane task orchestrator and fleet manager for Paperclip AI.

---

## 🏛️ Features & Architectural Invariants

### 1. Multi-Tier Review Pipeline & Anti-Hack Gate (`review-pipeline.ts`)
PRs follow an automated, ascending-cost validation chain:
```
[ PR Opened / Updated ] ──► [ 1. CI Gate (100% Green) ]
                                      │
                                      ▼
                            [ 2. OpenAI Luna Review (Cheap Triage) ]
                                      │
                                      ▼
                            [ 3. OpenAI Terra Review (Deep Audit) ]
                                      │
                                      ▼
                            [ 4. Operator Merge Card in Paperclip ]
                                      │
                                      ▼
                            [ Auto-Merge (--merge) & Done ]
```
- **Stage 1 (CI Gate):** PRs with pending or failing checks are held at `AWAIT_CI` to prevent wasting review tokens.
- **Stage 2 (Cheap Luna Review):** Read-only OpenAI Luna sanity and AST structure check. `REQUEST_CHANGES` immediately reassigns the issue back to the author worker, skipping expensive models.
- **Stage 3 (Deep Terra Review):** Read-only OpenAI Terra kernel invariant, memory safety, and Landlock audit.
- Review stages are native Paperclip verdict cards, keyed by immutable PR head and reviewer stage. Legacy Vibe/Strong cards cannot satisfy the Luna/Terra state machine. Missing reviewer identities fail closed instead of silently approving.
- **Stage 4 (Human Operator Gate):** 1-click Paperclip Board Approval Card (`task_merge_approval`).
- **Standard Merge Commit Strategy (`--merge`):** Approved PRs are merged via `gh pr merge --merge` (never squashed) to preserve exact git commit trees and eliminate downstream branch conflicts.
- **Iterative ACP Review Continuity:** Implementation workers retain their ACP session context; reviewers are separate read-only identities and inspect fresh branch diffs (`git diff origin/master...HEAD`).

### 2. Strict Anti-Hack, Test Protection & Zero-Bypass Standards
All reviewer prompts enforce explicit rejection criteria (`REQUEST_CHANGES`):
- **No Test Disabling or Removal:** Strictly reject any added `@Disabled`, `@Ignore`, commented-out assertions, deleted tests, or reduced test coverage (unless explicitly justified by an obsolete removed API).
- **No Dummy Tests:** Tests asserting only collection sizes or `entryCount` without executing behavioral/security paths are strictly rejected.
- **Zero Silent Bypasses:** Swallowing `EPERM`/`EACCES`, fallback modes (`SILENT_BYPASS`), or disabling security checks triggers immediate rejection.
- **No Suppressions:** Adding `@Suppress`, `@SuppressWarnings`, or ignoring compiler/linter warnings is forbidden.
- **Feature Completeness:** Stubs or missing dynamic edge cases must be fully implemented.

### 3. Formal Agent Failure & Incident Health Monitor (`agent-health-monitor.ts`)
- Evaluates company agents for formal failures, crash pauses (`SIGSEGV`, `429 Quota`, `401 Bad Auth`), and broken escalation chains on every scheduling tick.
- Incidents are typed as workflow-blocking or lane-degraded. A paused Vibe implementation lane remains visible and requires operator action, but it cannot block Jules dispatch or the Luna → Terra review ladder. Jules session counts are provider telemetry only and are never used to admit or suppress work.

### 4. Direct-to-Worker Review Handoff (`review-handoff.ts`)
- Review verdicts are maintained in Paperclip issue comments and relayed directly into worker session context (`client.sendMessage`).
- Reviews are never posted as noisy comments on GitHub PR threads.

### 5. Fleet Management & Concurrency Controls
- **Auto-Provisioned Managed Worker Fleet:** Dedicated worker agents (`[Orchestrated] Jules Async Worker`, `[Orchestrated] Vibe Local Worker`, `[Orchestrated] Antigravity Local Worker`, `[Orchestrated] Luna Fast Reviewer`, `[Orchestrated] Terra Strong Reviewer`) with zero polling drift (`pollCadenceSeconds: 0`).
- **Paperclip v2026.916 managed-agent compatibility:** Agent reads redact environment values, so managed workers persist only a SHA-256 digest of the complete adapter-owned configuration in `metadata.managedConfigFingerprint`; secret/config values are never copied into metadata. Visible non-secret fields are still compared directly. PATCH bodies omit `name` unless the managed identity is genuinely being renamed, because Paperclip revalidates the derived shortname whenever `name` is present and rejects an unchanged self-collision with HTTP 409. The fingerprint is advanced only by a successful server mutation, so a rejected PATCH remains retryable and cannot create false convergence.
- **Reviewer identity safety:** Luna/Terra are explicitly managed `codex_local` agents with read-only permissions. Their temporary adapters-only transport uses the built-in Codex CLI lane with `dangerouslyBypassApprovalsAndSandbox` and no Paperclip `networkScope`. A nested Codex sandbox cannot create its process namespace inside Paperclip Bubblewrap, and Paperclip's allowlist proxy cannot reliably reach its loopback control plane; either wrapper causes `EPERM` or `runtime_transport_error` before the MCP verdict is submitted. The reviewer remains read-only by contract and may resolve only its addressed native verdict card. `extraArgs` stays empty because Codex rejects `--approve-for-me` with the bypass flag. This is a compatibility workaround, not a general sandbox exemption: remove `NATIVE_REVIEW_CONTROL_PLANE_TRANSPORT` when Paperclip provides first-class native verdict submission without nested confinement. An unrelated personal Luna agent is never selected. If a local installation denies `agents:create`, reconciliation reports the missing grant instead of weakening this fence.
- **Provider-neutral decision capability:** Reviewer eligibility is based on a versioned capability advertised in agent metadata, never on adapter or model names. Adapters may opt into `mcp_tool`, `acp_tool`, or `adapter_callback` and declare which decision kinds they support. Dispatch validates the capability before creating a card or waking a model; unsupported adapters stop visibly and cannot fall back to prose. Luna/Terra are the current managed stage configuration, not protocol branches, and the shared ladder reducer accepts arbitrary weak/strong stage keys.
- **Fine-Grained Method-Level DAG & AST Concurrency:** Parses `target_symbols` and `target_files` to enable safe intra-file concurrency when tasks target disjoint AST symbols while locking overlapping functions.
- **Operator Start-Approval Gate:** Halts execution until explicit 1-click Board Approvals are approved in Paperclip with rich markdown links and symbol inspection.
- **Task Granularity & Autonomous Splitting Gate:** Detects multi-phase epics or cross-module sprawl and autonomously decomposes them into sequential sub-tasks with dependency links.
- **Agent Q&A adjudication:** Jules questions are delegated to the configured strong reviewer. It returns a strict structured answer only when confident, or an explicit escalation when a real ambiguity remains; provider prose is never regex-classified.
- **Daily Budget & Cost Optimization Tracker (`cost-tracker.ts`):** Tracks estimated cloud spend per session, displays real-time budget telemetry, and enforces configurable daily spending thresholds.
- **Self-Healing Stalled Session Reaper (48h Async Threshold):** Grants 48-hour reaper immunity to long-running asynchronous cloud workers (Jules) while reclaiming orphaned local runs idle $>15\text{ minutes}$ back to `todo`.
- **Jules continuation workaround (temporary):** Until Paperclip natively persists an external-provider poll as a continuation, the adapter performs cadence-limited, issue-scoped wakes using the last successful heartbeat run as `resumeFromRunId`. This bypasses Paperclip's no-progress re-wake throttle while preserving the existing Jules provider session. It uses only structured heartbeat state and never parses provider prose or creates monitor child issues. Remove this workaround when upstream monitor dispatch persists and exposes a reliable provider continuation state.
- **Native-review disposition containment (temporary):** Older Paperclip recovery logic does not recognize a native PR verdict card as a valid live disposition. It can therefore park the owner with `deliberate_wait_without_target` and leave an unbound reviewer heartbeat running. The adapter’s narrow `orphan-review-recovery.ts` shim cancels only reviewer runs for the affected issue that lack a pending `request_item_verdicts` card binding, and resolves only the matching generic repair action before the normal native-card pipeline runs. This is deliberately not a prose parser or a general recovery override. The proper Paperclip fix is to make review cards a first-class typed disposition, atomically propagate `interactionId`/`interactionKind` into heartbeat context, and make generic disposition repair ignore a live review stage. Remove the shim once that upstream behavior is available and covered by Paperclip’s own integration tests.
- **Typed plan-review compatibility (temporary):** Paperclip continuation provenance is issue-scoped: an interaction may cite a source heartbeat only when both belong to the same issue. Jules therefore stores Luna/Terra plan cards on the parent implementation issue and routes reviewers with `addresseeAgentId`; a reviewer child must never host a card sourced by the parent Jules run. Addressed cards use native-card continuation (`none`), and compatibility recovery revalidates the exact pending card and bound run before one bounded wake. The Jules owner performs replacement-first migration for persisted legacy child cards; the orchestrator dispatches only the resulting parent card. Remove the migration writer after persisted v2 sessions no longer contain `reviewerChildIssueId`; remove the recovery wake when Paperclip atomically dispatches every addressed card and persists its interaction binding across restarts.
- **Company-heartbeat managed-checkout compatibility (temporary):** Paperclip exposes a project’s managed checkout path immediately, but currently materializes it only while starting an issue-scoped host execution. This orchestrator schedules project state machines from a company heartbeat, so `project-managed-checkout.ts` atomically clones only the exact Paperclip-owned `instances/.../projects/<company>/<project>/<repo>` path before any local Git command. It rejects custom paths, never deletes an existing non-Git directory, and single-flights concurrent materialization. This is not a Jules worktree or a replacement workspace system; it is the missing host lifecycle call. Remove it when Paperclip provides an authorized project-checkout realization API for company-scoped adapters.
- **Hot-restart native-review recovery (temporary):** Paperclip can interrupt a reviewer and transiently project its source issue as `backlog` or reassign it during dev-server restart. `native-review-recovery-state.ts` restores only an addressed pending PR card whose typed idempotency identity exactly matches the immutable PR URL and head SHA. It waits for a live bound run, re-wakes the same card only after a terminal run without a verdict, and withdraws a superseded Jules plan card through the issue-scoped interaction API. It never infers state from comments or reviewer prose, creates a replacement card, or patches execution-policy stages. The upstream fix is atomic persistence of the interaction binding and review disposition across heartbeat restart recovery; remove this adapter fence when that exists.
- **Native PR-review ownership transfer (temporary):** Paperclip v831 may leave host `executionPolicy` review stages on an orchestrator-managed issue after Jules registers a ready PR. Those stages cannot consume the adapter's addressed `request_item_verdicts` cards, so they can re-enter review after Luna and Terra have already decided. For a managed ready PR with the native ladder configured, the orchestrator atomically projects `in_review`, clears the host policy/state, verifies that write, and then relies exclusively on the typed cards. Existing PR reviews deliberately bypass workspace-sync gating: synchronization protects new implementation dispatch, never a registered PR's review or merge lifecycle. Remove this handoff when Paperclip makes host execution-policy review stages consume the same typed verdict protocol.
- **Idempotent managed wakes:** Every orchestrator wake carries a stable `Idempotency-Key` derived from agent, issue, and resume run. Transient 429/5xx responses use bounded exponential retry; authorization, validation, not-found, and conflict responses are surfaced immediately.
- **Merged Feature Branch Pruner:** Discovers merged GitHub branches for safe pruning.

---

## ⚙️ Configuration Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiUrl` | `string` | `http://127.0.0.1:3100` | Paperclip core server URL |
| `workspacePath` | `string` | Current Repo | Path to working codebase |
| `julesCapacity` | `number` | `15` | Concurrency ceiling for cloud Jules lane |
| `vibeCapacity` | `number` | `2` | Concurrency ceiling for local Vibe/Antigravity lane |
| `requireTaskApproval` | `boolean` | `true` | Enforce 1-click operator board approval before task start |
| `dailyBudgetLimitUsd` | `number` | `10.0` | Daily spend ceiling for cloud sessions and strong model reviews |

---

## 🧪 Testing

```bash
# Run all workspace tests
pnpm test

# Build all packages
pnpm build

# Run the full isolated Paperclip lifecycle harness
PAPERCLIP_TEST_API_URL=http://localhost:3100 \
WORKSPACE_PATH=/path/to/project pnpm test:e2e

# Run only the fast Jules open-PR recovery canary
PAPERCLIP_TEST_API_URL=http://localhost:3100 \
WORKSPACE_PATH=/path/to/project pnpm test:e2e:jules-recovery
```

Both E2E commands create a disposable Paperclip company and delete it in a
`finally` block. The recovery canary uses a temporary `gh` fixture, so it does
not create Jules sessions, consume provider quota, or mutate GitHub. The API
URL and workspace must be explicit; the canary refuses non-loopback servers.

The lifecycle harness currently contains seven phases. The dedicated recovery
canary is the required pre-deployment smoke test because it specifically
verifies recovery of an `in_progress` Jules issue, stale-child cleanup, and
repeat-heartbeat idempotency.

The recovery canary must run against a Paperclip server whose process was
started with the deterministic `gh` fixture on its `PATH`; setting a PATH in
the client shell is insufficient because the orchestrator invokes `gh` in a
separate adapter process. The server-start environment must also export
`PAPERCLIP_E2E_GH_FIXTURE=server`. The canary refuses to create test data when
that marker is absent.

The Jules adapter's `e2eProviderBaseUrl` is similarly restricted to explicit
`PAPERCLIP_ADAPTER_E2E=1` loopback runs. It exists only to let a disposable
Paperclip server talk to a local fake Jules API; production always uses the
public Jules endpoint.

### Reusable real-provider dependency canary

`scripts/e2e-real-project-canary.ts` is the live A → B → C dependency probe.
It never creates a GitHub repository, company, or agents. Set
`PAPERCLIP_REAL_E2E=1`, `PAPERCLIP_TEST_API_URL`, `PAPERCLIP_E2E_COMPANY_ID`,
`PAPERCLIP_E2E_PROJECT_ID`, `PAPERCLIP_E2E_REPOSITORY_SSH_URL`, and
`PAPERCLIP_E2E_ORCHESTRATOR_ID`. The project ID is mandatory: the script
never creates or searches for a replacement project. It verifies that exact
project owns the existing SSH repository and has no unfinished marked canary
run, creates A/B/C atomically with native blocker IDs, validates authoritative
`blockedBy` edges, then wakes the existing orchestrator with an explicit
project-scope envelope. This is an adapter-only compatibility bridge: Paperclip
currently preserves `wakeReason` but can discard custom wake payload fields
when it coalesces an on-demand wake into a timer run. The envelope is accepted
only for on-demand wakes and is resolved from the server-owned heartbeat run
snapshot; malformed, missing, or conflicting scope evidence fails closed rather
than widening to a company-wide tick. Remove the envelope only once Paperclip
persists typed wake payloads through coalescing and every adapter invocation.

An on-demand wake must not be merged into a heartbeat that has already entered
`running`: the adapter may have already read that timer's scope and begun its
project loop, so no adapter-side reread can undo work already started. Paperclip
must queue a successor run for that case. The adapter logs an allowlisted scope
evidence record (`source`, `reason`, `wakeSource`, `wakeReason`, and direct
scope IDs) to make any server/adapter projection mismatch diagnosable without
writing tokens, payload bodies, or other sensitive run context to logs.

## Live Adapter Reload and Native-Review Recovery

External adapter modules are loaded from their built `dist/` entries when the
Paperclip server starts. After changing an adapter, build it and restart the
server; a running dev server does not watch this repository. Confirm the startup
log names `packages/orchestrator/dist/index.js`, then wait for one orchestrator
heartbeat to reconcile the managed worker fleet before waking a reviewer.

Paperclip v2026.916.0 can retain a
`legacy_execution_requires_reconciliation` blocker after a later Jules run has
already continued the same issue. The adapter may reconcile that stale blocker
only when the failed run, durable Jules session, issue, and agent identities all
match and a strictly newer successful run exists for that same issue and agent.
Generic board repair is fenced while the typed blocker exists. After Paperclip
accepts the mixed-outcome recovery, a detached monitor may be reattached from
`todo`, and Jules is woken only when an answered native plan card matches the
parent issue, provider session, and current plan revision. This compatibility
bridge can be removed when Paperclip invalidates superseded recovery blockers
atomically and natively wakes the parent assignee after a plan verdict.
The recovery reports `providerStopped: false`: the failed component is the
local heartbeat, while the Jules cloud session remains authoritative. Marking
the provider stopped makes Paperclip force a fresh session and invalidates the
typed interaction identities tied to the durable session.

For a failed native review, inspect the addressed card and reviewer runs first.
Recover only when exactly one card remains pending and the reviewer has no
queued/running run. The adapter re-reads both immediately before its legacy
compatibility wake; if the card was answered, dispatch is still in its normal
grace period, a run is live, or the read fails, it emits no wake or comment.
Reuse that card through
`packages/orchestrator/scripts/recover-native-review.mjs`; do not create a new
card or post a prose fallback. A successful review must make that same card
`answered`; a legitimate reject returns work to the implementer and is not a
transport failure.

The current managed Codex reviewer transport stores a mode-0600, non-secret,
static identity file beside its dedicated `CODEX_HOME`. This is an adapter-only
compatibility fallback for Paperclip/Codex launches that rewrite `config.toml`
and strip MCP environment entries. It contains only API base, company, and
agent ids—never task, run, token, interaction id, or verdict. At invocation,
the bridge requires exactly one live run for that reviewer, reads its
authoritative typed interaction binding, and sends both lookup and verdict
requests with that run ID. Zero, stale, or multiple candidate runs fail closed.
Remove this workaround when Paperclip atomically passes the native interaction
binding and runtime environment into the reviewer process.

This MCP implementation is one implementation of the shared structured-decision
contract, not the contract itself. ACP adapters and remote/provider adapters
should expose the same outcomes through `acp_tool` or `adapter_callback`.
Comments, prompt JSON, and provider prose are intentionally not transports.
