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
- High-visibility alerts are emitted to console logs and rendered dynamically on the pinned Paperclip Dashboard Telemetry Card.

### 4. Direct-to-Worker Review Handoff (`review-handoff.ts`)
- Review verdicts are maintained in Paperclip issue comments and relayed directly into worker session context (`client.sendMessage`).
- Reviews are never posted as noisy comments on GitHub PR threads.

### 5. Fleet Management & Concurrency Controls
- **Auto-Provisioned Managed Worker Fleet:** Dedicated worker agents (`[Orchestrated] Jules Async Worker`, `[Orchestrated] Vibe Local Worker`, `[Orchestrated] Antigravity Local Worker`, `[Orchestrated] Luna Fast Reviewer`, `[Orchestrated] Terra Strong Reviewer`) with zero polling drift (`pollCadenceSeconds: 0`).
- **Reviewer identity safety:** Luna/Terra are explicitly managed `codex_local` agents with read-only permissions. Their temporary adapters-only transport uses the built-in Codex CLI lane with `dangerouslyBypassApprovalsAndSandbox` and no Paperclip `networkScope`. A nested Codex sandbox cannot create its process namespace inside Paperclip Bubblewrap, and Paperclip's allowlist proxy cannot reliably reach its loopback control plane; either wrapper causes `EPERM` or `runtime_transport_error` before the MCP verdict is submitted. The reviewer remains read-only by contract and may resolve only its addressed native verdict card. `extraArgs` stays empty because Codex rejects `--approve-for-me` with the bypass flag. This is a compatibility workaround, not a general sandbox exemption: remove `NATIVE_REVIEW_CONTROL_PLANE_TRANSPORT` when Paperclip provides first-class native verdict submission without nested confinement. An unrelated personal Luna agent is never selected. If a local installation denies `agents:create`, reconciliation reports the missing grant instead of weakening this fence.
- **Fine-Grained Method-Level DAG & AST Concurrency:** Parses `target_symbols` and `target_files` to enable safe intra-file concurrency when tasks target disjoint AST symbols while locking overlapping functions.
- **Operator Start-Approval Gate:** Halts execution until explicit 1-click Board Approvals are approved in Paperclip with rich markdown links and symbol inspection.
- **Task Granularity & Autonomous Splitting Gate:** Detects multi-phase epics or cross-module sprawl and autonomously decomposes them into sequential sub-tasks with dependency links.
- **Agent Q&A adjudication:** Jules questions are delegated to the configured strong reviewer. It returns a strict structured answer only when confident, or an explicit escalation when a real ambiguity remains; provider prose is never regex-classified.
- **Daily Budget & Cost Optimization Tracker (`cost-tracker.ts`):** Tracks estimated cloud spend per session, displays real-time budget telemetry, and enforces configurable daily spending thresholds.
- **Self-Healing Stalled Session Reaper (48h Async Threshold):** Grants 48-hour reaper immunity to long-running asynchronous cloud workers (Jules) while reclaiming orphaned local runs idle $>15\text{ minutes}$ back to `todo`.
- **Jules continuation workaround (temporary):** Until Paperclip natively persists an external-provider poll as a continuation, the adapter performs cadence-limited, issue-scoped wakes using the last successful heartbeat run as `resumeFromRunId`. This bypasses Paperclip's no-progress re-wake throttle while preserving the existing Jules provider session. It uses only structured heartbeat state and never parses provider prose or creates monitor child issues. Remove this workaround when upstream monitor dispatch persists and exposes a reliable provider continuation state.
- **Native-review disposition containment (temporary):** Older Paperclip recovery logic does not recognize a native PR verdict card as a valid live disposition. It can therefore park the owner with `deliberate_wait_without_target` and leave an unbound reviewer heartbeat running. The adapter’s narrow `orphan-review-recovery.ts` shim cancels only reviewer runs for the affected issue that lack a pending `request_item_verdicts` card binding, and resolves only the matching generic repair action before the normal native-card pipeline runs. This is deliberately not a prose parser or a general recovery override. The proper Paperclip fix is to make review cards a first-class typed disposition, atomically propagate `interactionId`/`interactionKind` into heartbeat context, and make generic disposition repair ignore a live review stage. Remove the shim once that upstream behavior is available and covered by Paperclip’s own integration tests.
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

## Live Adapter Reload and Native-Review Recovery

External adapter modules are loaded from their built `dist/` entries when the
Paperclip server starts. After changing an adapter, build it and restart the
server; a running dev server does not watch this repository. Confirm the startup
log names `packages/orchestrator/dist/index.js`, then wait for one orchestrator
heartbeat to reconcile the managed worker fleet before waking a reviewer.

For a failed native review, inspect the addressed card and reviewer runs first.
Recover only when exactly one card remains pending and the reviewer has no
queued/running run. Reuse that card through
`packages/orchestrator/scripts/recover-native-review.mjs`; do not create a new
card or post a prose fallback. A successful review must make that same card
`answered`; a legitimate reject returns work to the implementer and is not a
transport failure.
