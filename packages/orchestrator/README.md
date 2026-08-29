# 🎛️ @pilleo/paperclip-orchestrator-adapter

Deterministic, multi-lane task orchestrator and fleet manager for Paperclip AI.

---

## 🏛️ Features

- **Auto-Provisioned Managed Worker Fleet:** Automatically provisions and locks dedicated worker agents (`[Orchestrated] Jules Async Worker`, `[Orchestrated] Vibe Local Worker`, `[Orchestrated] Antigravity Local Worker`, `[Orchestrated] Code Reviewer`) with `pollCadenceSeconds: 0`.
- **Fine-Grained Method-Level DAG:** Parses `target_symbols` and `target_files` to enable safe intra-module concurrency while locking overlapping methods.
- **Operator Start-Approval Gate:** Halts execution until explicit 1-click Board Approvals are approved in Paperclip.
- **Autonomous Clarifier Q&A Loop:** Routes open questions to local Vibe/Antigravity lanes for autonomous resolution against local source code before dispatch.
- **Token-Friendly Review Synthesizer:** Formats surgical review requests referencing target AST symbols, blast radius, and invariants.
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

---

## 🧪 Testing

```bash
# Run orchestrator unit tests
pnpm test

# Run live E2E orchestration lifecycle
pnpm --filter @pilleo/paperclip-adapters-monorepo test:e2e
```
