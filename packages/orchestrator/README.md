# 🎛️ @pilleo/paperclip-orchestrator-adapter

Deterministic, multi-lane task orchestrator and fleet manager for Paperclip AI.

---

## 🏛️ Features

- **Auto-Provisioned Managed Worker Fleet:** Automatically provisions and locks dedicated worker agents (`[Orchestrated] Jules Async Worker`, `[Orchestrated] Vibe Local Worker`, `[Orchestrated] Antigravity Local Worker`, `[Orchestrated] Code Reviewer`) with `pollCadenceSeconds: 0`.
- **Fine-Grained Method-Level DAG & AST Concurrency:** Parses `target_symbols` and `target_files` to enable safe intra-file concurrency when tasks target disjoint AST symbols while locking overlapping functions.
- **Operator Start-Approval Gate:** Halts execution until explicit 1-click Board Approvals are approved in Paperclip with rich markdown links and symbol inspection.
- **Task Granularity & Autonomous Splitting Gate:** Detects multi-phase epics or cross-module sprawl and autonomously decomposes them into sequential sub-tasks with dependency links.
- **Pre-Implementation Refactoring Gate:** *"Make the change easy, then make the easy change."* Evaluates legacy code complexity and spins off preparatory refactoring sub-tasks before functional features are built.
- **Autonomous Q&A Clarification Firewall (`qa-firewall.ts`):** Evaluates worker questions using strong models (Grok, Gemini, GPT-4o, Claude) to auto-answer spec-covered inquiries or gracefully escalate to the operator.
- **Token-Efficient Strong Model PR Reviewer (`strong-model-reviewer.ts`):** Audits green-CI PRs using Grok / Terra / GPT-4o over compact surgical diffs, enforcing kernel invariants and posting review verdicts and questions directly to the GitHub PR.
- **Daily Budget & Cost Optimization Tracker (`cost-tracker.ts`):** Tracks estimated cloud spend per session, displays real-time budget telemetry, and enforces configurable daily spending thresholds.
- **Pluggable Invariants Engine:** Validates hygiene rules and project-specific invariants from `.paperclip/invariants.json`.
- **Self-Healing Stalled Session Reaper:** Reclaims orphaned runs idle $>15\text{ minutes}$ back to `todo`.
- **Visual Rate-Limit Cooldown Tracker:** Displays live countdowns in Paperclip during Jules API rate limits.
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
# Run orchestrator unit tests
pnpm test

# Run live E2E orchestration lifecycle
pnpm --filter @pilleo/paperclip-adapters-monorepo test:e2e
```
