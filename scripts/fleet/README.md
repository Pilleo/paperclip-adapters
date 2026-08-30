# 🛠️ Paperclip Fleet Operations & Management Scripts

A suite of modular, zero-dependency bash scripts for operating, triaging, and inspecting the Paperclip AI worker fleet, Orchestrator ticks, code review progression, and approvals.

---

## 📂 Available Scripts Index

| Script | Purpose | Usage Example |
|---|---|---|
| [`wake_orchestrator.sh`](wake_orchestrator.sh) | Forces an immediate deterministic scheduling tick in Orchestrator. | `./scripts/fleet/wake_orchestrator.sh` |
| [`wake_jules.sh`](wake_jules.sh) | Wakes up Jules Async Worker to process sessions or apply review changes. | `./scripts/fleet/wake_jules.sh` |
| [`wake_reviewer.sh`](wake_reviewer.sh) | Wakes up Code Reviewer to evaluate in-review PRs. | `./scripts/fleet/wake_reviewer.sh` |
| [`wake_vibe.sh`](wake_vibe.sh) | Wakes up Vibe Local Worker for interviews, clarifications, or Stage 2 reviews. | `./scripts/fleet/wake_vibe.sh` |
| [`list_issues.sh`](list_issues.sh) | Lists company tasks with status, priority, and assignees. | `./scripts/fleet/list_issues.sh in_review` |
| [`view_issue_comments.sh`](view_issue_comments.sh) | Displays comments and review history for a specific issue (UUID or identifier). | `./scripts/fleet/view_issue_comments.sh MAZ-141 3` |
| [`list_approvals.sh`](list_approvals.sh) | Lists pending task start authorizations and Stage 4 merge approval cards. | `./scripts/fleet/list_approvals.sh pending` |
| [`list_agents.sh`](list_agents.sh) | Lists all fleet agents, roles, error reasons, and chain of command health. | `./scripts/fleet/list_agents.sh` |
| [`run_telegram_companion.sh`](run_telegram_companion.sh) | Starts the interactive Telegram bot companion for live cards and push alerts. | `./scripts/fleet/run_telegram_companion.sh` |

---

## ⚙️ Environment Overrides

All scripts source [`common.sh`](common.sh) and respect standard environment variables:

```bash
export PAPERCLIP_API_URL="http://127.0.0.1:3100"
export COMPANY_ID="8f4ef932-d769-43b2-981a-d273ed715162" # mazewall
```

---

## 🚀 Common Operational Workflows

### 1. Triggering an Immediate Orchestration Cycle
```bash
./scripts/fleet/wake_orchestrator.sh "manual_triage_tick"
```

### 2. Checking Review Verdicts on a Task
```bash
./scripts/fleet/view_issue_comments.sh MAZ-141
```

### 3. Reviewing Pending Board Approvals (Start Gate & Merge Cards)
```bash
./scripts/fleet/list_approvals.sh pending
```

### 4. Inspecting Fleet Health for Formal Failures
```bash
./scripts/fleet/list_agents.sh
```
