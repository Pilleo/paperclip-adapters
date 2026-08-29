# 📎 Paperclip Adapters Suite

Production-grade, deterministic, multi-agent adapters for **[Paperclip AI](https://github.com/paperclipai/paperclip)**. 

This repository contains the complete adapter monorepo connecting Paperclip's control-plane with **Google Jules (Cloud Async Developer)**, **Mistral Vibe (Local ACP Developer)**, **Google Antigravity (Local ACP Developer)**, and a **Deterministic Multi-Lane Task Orchestrator**.

---

## 🏛️ System Architecture

```mermaid
flowchart TD
    subgraph Control Plane (Paperclip Core)
        P[Paperclip API / Kanban Board]
        AP[Operator Start-Approval Gate]
        IA[Interactive Reply Cards]
        TL[Live Telemetry Dashboard Card]
    end

    subgraph Orchestrator Control Plane (@pilleo/paperclip-orchestrator-adapter)
        O[Deterministic Orchestrator Tick]
        FL[Auto-Provisioned Managed Worker Fleet]
        DAG[Fine-Grained Method DAG & Lock Matrix]
        PL[Deterministic Planning & Blast Radius Engine]
        INV[Pluggable Invariant Engine]
        RPR[Stalled-Session Auto-Reaper]
        CLR[Autonomous Clarifier Q&A Loop]
        RS[Token-Friendly Review Synthesizer]
        BP[Merged Branch Pruner]
    end

    subgraph Locked Managed Worker Fleet (pollCadence: 0)
        J["[Orchestrated] Jules Async Worker (Cloud)"]
        V["[Orchestrated] Vibe Local Worker (ACP)"]
        AGY["[Orchestrated] Antigravity Local Worker (ACP)"]
        REV["[Orchestrated] Code Reviewer (Token-Friendly)"]
    end

    P <-->|2-Way Markdown & State Sync| O
    O --> FL
    FL -->|Provisions & Locks (pollCadence: 0)| J
    FL -->|Provisions & Locks (pollCadence: 0)| V
    FL -->|Provisions & Locks (pollCadence: 0)| AGY
    FL -->|Provisions & Locks (pollCadence: 0)| REV

    O --> DAG
    DAG --> PL
    PL --> INV
    O --> RPR
    O --> CLR
    O --> BP
    
    O -->|1-Click Approval Granted| J
    O -->|1-Click Approval Granted| V
    O -->|1-Click Approval Granted| AGY
    
    J -->|PR Created -> in_review| RS
    RS -->|Token-Efficient Review Prompt| REV
```

---

## 📦 Packages in Monorepo

| Package | Directory | Description |
|---|---|---|
| **`@pilleo/paperclip-adapter-common`** | [`packages/common`](./packages/common) | Shared protocol types, linter, planning engine, blast radius extractor, and skills materializer. |
| **`@pilleo/paperclip-orchestrator-adapter`** | [`packages/orchestrator`](./packages/orchestrator) | Multi-lane scheduler, auto-provisioned managed fleet, method-level DAG, invariant engine, and telemetry card. |
| **`@pilleo/paperclip-jules-adapter`** | [`packages/jules`](./packages/jules) | Google Jules cloud runner with activity replay, UI accordions, token recovery, and checkpoint sync. |
| **`@pilleo/paperclip-vibe-adapter`** | [`packages/vibe`](./packages/vibe) | Mistral Vibe local runner executing via Agent Client Protocol (ACP) over stdio with subshell isolation. |
| **`@pilleo/paperclip-antigravity-adapter`** | [`packages/antigravity`](./packages/antigravity) | Google Antigravity local runner executing via ACP stdio subshell with shared skills mounting. |

---

## ⚡ Key Architectural Invariants

### 1. 🛡️ Managed Worker Fleet & Locked Zero-Cadence Scheduling
- The Orchestrator automatically provisions its dedicated worker fleet on startup:
  - `[Orchestrated] Jules Async Worker` (`adapterType: "jules"`)
  - `[Orchestrated] Vibe Local Worker` (`adapterType: "vibe"`)
  - `[Orchestrated] Antigravity Local Worker` (`adapterType: "antigravity"`)
  - `[Orchestrated] Code Reviewer` (`adapterType: "vibe"`)
- **Locked Zero-Cadence (`pollCadenceSeconds: 0`):** All managed workers are locked with `pollCadenceSeconds: 0` and `status: "idle"`. Paperclip's internal background scheduler will **never** autonomously pull unapproved tasks or flood the board. Workers execute **strictly on-demand** when the Orchestrator dispatches a targeted execution wakeup (`POST /api/agents/:workerId/wakeup`).

### 2. 🚦 1-Click Operator Start-Approval Gate
- The operator retains 100% authority over code execution. Tasks remain safely staged in `backlog` / `todo` until an operator approves execution via Paperclip Board Approval cards.

### 3. 🔍 Token-Friendly Code Review Dispatcher
- When tasks enter `in_review`, the Orchestrator synthesizes a compact review prompt with direct PR links, target symbols, Codanna blast radius test suites, and project invariants, instructing the reviewer to inspect only specific target symbols using AST tools without dumping full file contents.

### 4. ⏳ Visual Rate-Limit Cooldown & Automatic Quota Recovery
- When Jules cloud returns a `429 Rate Limit`, the orchestrator tracks `rateLimitPausedUntilMs` and displays a live countdown timer in the Paperclip dashboard card (`⏸️ Paused (Rate limit cooldown: 3m 12s remaining)`). It automatically resumes dispatches once capacity clears.

### 5. 🧹 Merged Feature Branch Pruning
- Scans GitHub for merged feature branches associated with completed PRs and marks them for cleanup while strictly protecting `master` and `main`.

---

## 🛠️ Developer Commands & CI Pipeline

```bash
# Install all dependencies across workspace
pnpm install

# Typecheck and build all 5 packages
pnpm -r build

# Run all 405+ unit and integration tests
pnpm -r test

# Run the deep ephemeral live E2E lifecycle test against Paperclip
pnpm test:e2e

# Package all verified production tarballs for release/deployment
pnpm release:pack
```

Distribution packages are validated and output directly to `dist-packages/*.tgz`.
