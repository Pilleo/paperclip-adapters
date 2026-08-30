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
                            [ 2. Vibe Fast Review (Cheap Triage) ]
                                      │
                                      ▼
                            [ 3. Strong Review (Terra/Grok Audit) ]
                                      │
                                      ▼
                            [ 4. Operator Merge Card in Paperclip ]
                                      │
                                      ▼
                            [ Auto-Merge (--merge) & Done ]
```
- **Stage 1 (CI Gate):** PRs with pending or failing checks are held at `AWAIT_CI` to prevent wasting review tokens.
- **Stage 2 (Cheap Vibe Review):** Fast ACP sanity and AST structure check. `REQUEST_CHANGES` immediately reassigns the issue back to the author worker, skipping expensive models.
- **Stage 3 (Deep Strong Review):** Deep kernel invariant, memory safety, and Landlock audit.
- **Stage 4 (Human Operator Gate):** 1-click Paperclip Board Approval Card (`task_merge_approval`).
- **Standard Merge Commit Strategy (`--merge`):** Approved PRs are merged via `gh pr merge --merge` (never squashed) to preserve exact git commit trees and eliminate downstream branch conflicts.
- **Iterative ACP Review Continuity:** Vibe’s ACP session context (`sessionId`) is preserved between wakeups so it remembers prior feedback while inspecting fresh branch diffs (`git diff origin/master...HEAD`).

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
- **Auto-Provisioned Managed Worker Fleet:** Dedicated worker agents (`[Orchestrated] Jules Async Worker`, `[Orchestrated] Vibe Local Worker`, `[Orchestrated] Antigravity Local Worker`, `[Orchestrated] Code Reviewer`) with zero polling drift (`pollCadenceSeconds: 0`).
- **Fine-Grained Method-Level DAG & AST Concurrency:** Parses `target_symbols` and `target_files` to enable safe intra-file concurrency when tasks target disjoint AST symbols while locking overlapping functions.
- **Operator Start-Approval Gate:** Halts execution until explicit 1-click Board Approvals are approved in Paperclip with rich markdown links and symbol inspection.
- **Task Granularity & Autonomous Splitting Gate:** Detects multi-phase epics or cross-module sprawl and autonomously decomposes them into sequential sub-tasks with dependency links.
- **Autonomous Q&A Clarification Firewall (`qa-firewall.ts`):** Evaluates worker questions using strong models (Grok, Gemini, GPT-4o, Claude) to auto-answer spec-covered inquiries or gracefully escalate to the operator.
- **Daily Budget & Cost Optimization Tracker (`cost-tracker.ts`):** Tracks estimated cloud spend per session, displays real-time budget telemetry, and enforces configurable daily spending thresholds.
- **Self-Healing Stalled Session Reaper (48h Async Threshold):** Grants 48-hour reaper immunity to long-running asynchronous cloud workers (Jules) while reclaiming orphaned local runs idle $>15\text{ minutes}$ back to `todo`.
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
# Run all orchestrator unit tests (100% green)
pnpm test

# Build all packages
pnpm build
```
