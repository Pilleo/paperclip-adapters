# 🚀 Developer Onboarding Guide: Paperclip Adapters & Multi-Agent Fleet

Welcome to the **Paperclip AI Adapters & Multi-Agent Orchestration Monorepo** (`paperclip-adapters`).

This repository contains the deterministic multi-lane orchestrator, execution adapters, and operator companions that power autonomous software engineering for the **mazewall** kernel security project.

---

## 🏛️ High-Level System Architecture

```
                                    ┌─────────────────────────────────────┐
                                    │      Paperclip Core Server          │
                                    │    (Postgres + HTTP API :3100)      │
                                    └──────────────────┬──────────────────┘
                                                       │
                           ┌───────────────────────────┴───────────────────────────┐
                           ▼                                                       ▼
        ┌──────────────────────────────────────┐                ┌──────────────────────────────────────┐
        │  Task Orchestrator                   │                │  Telegram Operator Companion         │
        │  (@pilleo/paperclip-orchestrator)    │                │  (@pilleo/paperclip-telegram)        │
        │  • Fine-Grained AST Lock Matrix      │                │  • 1-Click Task Start Approvals      │
        │  • Multi-Tier PR Review Ladder       │                │  • Stage 4 Merge Approval Cards      │
        │  • Agent Failure & Health Monitor    │                │  • Real-time Incident Alerts         │
        └──────────────────┬───────────────────┘                └──────────────────────────────────────┘
                           │
        ┌──────────────────┴───────────────────────────────────────────────────────┐
        ▼                                      ▼                                   ▼
┌───────────────────────────────┐  ┌───────────────────────────────┐  ┌───────────────────────────────┐
│ [Orchestrated] Jules Worker   │  │ [Orchestrated] Vibe Worker    │  │ [Orchestrated] Code Reviewer  │
│ (Cloud Async Developer)       │  │ (Local Fast ACP Developer)    │  │ (Terra/Grok Strong Reviewer)  │
│ • Long-running cloud sessions │  │ • Fast AST refactoring        │  │ • Kernel & FFM Invariant audit│
│ • Surgical git branch commits │  │ • Q&A clarification interviews│  │ • Strict zero-bypass checks   │
│ • Direct session review relay │  │ • Stage 2 fast PR triage      │  │ • Token-efficient diff review │
└───────────────────────────────┘  └───────────────────────────────┘  └───────────────────────────────┘
```

---

## 📦 Monorepo Package Layout

| Package Path | Purpose | Key Responsibilities |
|---|---|---|
| [`packages/orchestrator`](../packages/orchestrator) | Fleet Orchestrator & DAG Dispatcher | AST conflict detection, multi-tier review pipeline (`review-pipeline.ts`), agent health tracking (`agent-health-monitor.ts`), 1-click approvals (`approvals.ts`). |
| [`packages/jules`](../packages/jules) | Google Jules Cloud Adapter | Stateful bridge between Paperclip and Jules Cloud API (`state-engine.ts`), PR review feedback relay, watchdog keepalives. |
| [`packages/vibe`](../packages/vibe) | Mistral Vibe ACP Adapter | Local Agent Client Protocol (ACP) worker for rapid clarifications, task interviews, and Stage 2 fast code review. |
| [`packages/antigravity`](../packages/antigravity) | Google Antigravity ACP Adapter | Local deep systems engineering and interactive tool-calling pair programming. |
| [`packages/telegram`](../packages/telegram) | Operator Telegram Companion | Push notifications, board telemetry digests, interactive plan/merge approval buttons. |
| [`packages/common`](../packages/common) | Shared Adapter Utilities | Common session codecs, logging abstractions, process runner helpers. |

---

## ⚡ Quick Start (Zero to Running in 60s)

### 1. Prerequisites
- **Node.js $\ge 22.0.0$** and **pnpm $\ge 9.0.0$**
- **GitHub CLI (`gh`)** authenticated with write access to `Pilleo/mazewall`
- **jq** and **curl** installed on Linux / macOS

### 2. Install & Build
```bash
git clone https://github.com/Pilleo/paperclip-adapters.git
cd paperclip-adapters
pnpm install
pnpm build
```

### 3. Run Pre-Flight Doctor
Validate your local environment, ports, API connectivity, and GitHub CLI:
```bash
pnpm fleet:doctor
```

### 4. Inspect Active Fleet & Issues
```bash
pnpm fleet:agents    # Check agent statuses & health
pnpm fleet:issues    # View all board tasks
pnpm fleet:approvals # View pending approvals
```

### 5. Launch Interactive CLI Dashboard
```bash
pnpm fleet:dashboard
```

---

## 🔄 The 4-Stage Pull Request Validation Ladder

When an agent opens a Pull Request on GitHub, it must strictly pass through 4 validation gates:

```
[ Pull Request Opened ] ──► [ Stage 1: CI Build Gate (100% Green) ]
                                            │
                                            ▼
                            [ Stage 2: Cheap Vibe Fast Review ]
                                            │
                                            ▼
                            [ Stage 3: Deep Strong Review (Terra/Grok) ]
                                            │
                                            ▼
                            [ Stage 4: Operator Merge Card in Paperclip ]
                                            │
                                            ▼
                            [ Automated Merge (--merge) & Done ]
```

1. **Stage 1 (CI Gate):** PR checks must be 100% green. If checks are pending or failed, the PR is held at `AWAIT_CI` to prevent wasting review tokens.
2. **Stage 2 (Vibe Fast Review):** Fast, cheap AST structural sanity check. If issues are found (`REQUEST_CHANGES`), it reassigns directly to the worker, skipping expensive models.
3. **Stage 3 (Deep Strong Review):** In-depth audit of kernel safety, FFM layout alignment, memory lifecycle discipline, and zero silent exception bypasses.
4. **Stage 4 (Operator Final Approval):** Generates a 1-click Paperclip Board Approval Card (`task_merge_approval`).
5. **Standard Merge (`--merge`):** Approved PRs are merged using standard merge commits (`gh pr merge --merge`). Squashing is strictly forbidden.

---

## 🛠️ Common Daily Commands & Runbook

| Action | Shortcut Command | Raw Script |
|---|---|---|
| **Trigger Orchestrator Tick** | `pnpm fleet:tick` | `./scripts/fleet/wake_orchestrator.sh` |
| **Wake Up Jules Worker** | `pnpm fleet:jules` | `./scripts/fleet/wake_jules.sh` |
| **Wake Up Code Reviewer** | `pnpm fleet:reviewer` | `./scripts/fleet/wake_reviewer.sh` |
| **Wake Up Vibe Worker** | `pnpm fleet:vibe` | `./scripts/fleet/wake_vibe.sh` |
| **View Board Tasks** | `pnpm fleet:issues` | `./scripts/fleet/list_issues.sh` |
| **View Task Comments / Reviews** | `pnpm fleet:comments MAZ-141` | `./scripts/fleet/view_issue_comments.sh MAZ-141` |
| **List Pending Approvals** | `pnpm fleet:approvals` | `./scripts/fleet/list_approvals.sh pending` |
| **Check Agent Health & Incidents** | `pnpm fleet:agents` | `./scripts/fleet/list_agents.sh` |
| **Run Telegram Bot** | `pnpm fleet:telegram` | `./scripts/fleet/run_telegram_companion.sh` |
| **Run Full Test Suite** | `pnpm test` | `pnpm test` |
| **Run Pre-Flight Doctor** | `pnpm fleet:doctor` | `./scripts/fleet/doctor.sh` |

---

## 🚨 Troubleshooting & FAQ

### Q: Why is a task stuck in `in_review` without being reviewed?
**A:** Check the GitHub PR CI status. PRs with pending or failing GitHub Action runs are intentionally held at `AWAIT_CI` until the build passes 100%.

### Q: Why are review comments not visible on GitHub PR threads?
**A:** This is intentional. Reviews are kept in Paperclip issue comments and relayed directly to the Jules Cloud Session API (`client.sendMessage`) to avoid polluting public PR discussions.

### Q: An agent is in `error` status. How do I fix it?
**A:** Run `pnpm fleet:agents` to inspect `errorReason`. After resolving the issue (e.g. invalid API token), wake up the agent via `pnpm fleet:jules` or `pnpm fleet:reviewer` to clear the error status.
