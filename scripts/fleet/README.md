# 🛠️ Paperclip Fleet Operations & Management Scripts

A suite of modular, zero-dependency bash scripts for operating, triaging, and inspecting the Paperclip AI worker fleet, Orchestrator ticks, code review progression, and approvals.

---

## 📂 Available Scripts Index

| Script | Purpose | Usage Example |
|---|---|---|
| [`wake_orchestrator.sh`](wake_orchestrator.sh) | Forces an immediate project-scoped deterministic scheduling tick in Orchestrator. | `./scripts/fleet/wake_orchestrator.sh <project_id>` |
| [`wake_jules.sh`](wake_jules.sh) | Wakes up Jules Async Worker to process sessions or apply review changes. | `./scripts/fleet/wake_jules.sh` |
| [`wake_reviewer.sh`](wake_reviewer.sh) | Wakes up Code Reviewer to evaluate in-review PRs. | `./scripts/fleet/wake_reviewer.sh` |
| [`wake_vibe.sh`](wake_vibe.sh) | Wakes up Vibe Local Worker for interviews, clarifications, or Stage 2 reviews. | `./scripts/fleet/wake_vibe.sh` |
| [`list_issues.sh`](list_issues.sh) | Lists company tasks with status, priority, and assignees. | `./scripts/fleet/list_issues.sh in_review` |
| [`view_issue_comments.sh`](view_issue_comments.sh) | Displays comments and review history for a specific issue (UUID or identifier). | `./scripts/fleet/view_issue_comments.sh MAZ-141 3` |
| [`list_approvals.sh`](list_approvals.sh) | Lists pending task start authorizations and Stage 4 merge approval cards. | `./scripts/fleet/list_approvals.sh pending` |
| [`list_agents.sh`](list_agents.sh) | Lists all fleet agents, roles, error reasons, and chain of command health. | `./scripts/fleet/list_agents.sh` |
| [`run_telegram_companion.sh`](run_telegram_companion.sh) | Starts the interactive Telegram bot companion for live cards and push alerts. | `./scripts/fleet/run_telegram_companion.sh` |
| [`diagnostics.sh`](diagnostics.sh) | Read-only service, Jules heartbeat, marked-child, and capability-incident summary. | `./scripts/fleet/diagnostics.sh` |
| [`reload_adapters.mjs`](reload_adapters.mjs) | Journaled native task-drain barrier, idle restart, dist load and fresh heartbeat verification. | See reload workflow below. |
| [`reconcile_stale_children.sh`](reconcile_stale_children.sh) | Finds stale Jules supervisor/adjudication children; dry-run by default. | `./scripts/fleet/reconcile_stale_children.sh --apply` |
| [`reconcile_jules_prs.mjs`](reconcile_jules_prs.mjs) | Manual emergency convergence of verified ready Jules PRs into review; closes false productivity blockers. | `node scripts/fleet/reconcile_jules_prs.mjs --dry-run --json` |
| [`install_jules_pr_reconciler_timer.sh`](install_jules_pr_reconciler_timer.sh) | Installs the deprecated compatibility timer; normal recovery is now performed by the orchestrator heartbeat. | Use only for documented emergency rollback/recovery testing. |

---

## ⚙️ Environment Overrides

All scripts source [`common.sh`](common.sh) and respect standard environment variables:

```bash
export PAPERCLIP_API_URL="http://127.0.0.1:3100"
export COMPANY_ID="8f4ef932-d769-43b2-981a-d273ed715162" # mazewall
```

The Jules PR reconciler intentionally uses the authenticated board CLI context,
not an adapter token. It only advances an issue when its Jules-linked GitHub PR
is open, mergeable, non-draft, and all reported checks completed successfully.
The timer is disabled in the supported deployment because running both the
adapter heartbeat and the compatibility bridge can duplicate recovery actions.
Prefer the adapter's native recovery path and the isolated
`test:e2e:jules-recovery` canary.

---

## 🚀 Common Operational Workflows

### 1. Triggering an Immediate Orchestration Cycle
```bash
./scripts/fleet/wake_orchestrator.sh "<paperclip-project-id>"
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

### 5. Reloading an External Adapter Safely

Paperclip loads external adapter packages only at server startup. Build the
affected workspace, then use the verified native task-drain reload command:

```bash
mkdir -m 700 /tmp/paperclip-reload-unique
node scripts/fleet/reload_adapters.mjs \
  --journal /tmp/paperclip-reload-unique/receipts.jsonl \
  --reconcile-company 8f4ef932-d769-43b2-981a-d273ed715162 \
  --reconcile-agent f9bf7329-0649-4c0d-bfe0-680cfd9e8c9a
```

The command starts the host's admission hold **before** waiting for quiescence,
checks every accessible company's authoritative live-run list, and keeps the
hold through the old-process stop. It then confirms the replacement API reset
the drain, startup loaded orchestrator/Jules `dist/index.js`, and a new managed
orchestrator heartbeat succeeded. An ordinary idle read is not an admission
barrier: the scheduler can start work between that read and a bare restart.

Use a fresh owner-only journal directory/file per attempt. Existing drains,
queued runs, changed drain epochs and expired holds fail closed. A pre-restart
failure releases only the verified owned epoch; an uncertain restart outcome
retains the bounded hold and must be inspected instead of retried. Other
operator changes to the global drain are detected by epoch reads; this host
does not expose a compare-and-set drain API. Do not wake a reviewer before
reconciliation finishes.

### 6. Recovering One Failed Native Review Without Spam

First inspect the issue interactions and the addressed reviewer's latest
heartbeat runs. Do not wake a reviewer or reuse a card manually. After its
grace period the adapter either observes a bound run, sends one idempotent
public interaction wake for that exact no-run card, replaces exactly one card
after a terminal bound reviewer run, or records a visible protocol failure.
Normal comments and a second concurrent wake are recovery failures, not
progress. `recover-native-review.mjs` is intentionally diagnostic-only.

If the reviewer reports `missing_runtime_context`, treat the terminal run as a
transport failure, not a review decision. The orchestrator uses its bounded
terminal-run replacement path; do not reassign the issue to Jules or write a
prose fallback.
