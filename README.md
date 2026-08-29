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
        DAG[AST-Aware Method DAG & Lock Matrix]
        PL[Deterministic Planning & Blast Radius Engine]
        INV[Pluggable Invariant Engine]
        RPR[Stalled-Session Auto-Reaper]
        QA[Autonomous Q&A Clarification Firewall]
        SPLIT[Task Granularity & Splitting Gate]
        REF[Pre-Implementation Refactoring Gate]
        REV[Strong Model PR Reviewer - Grok/Terra]
        COST[Daily Budget & Cost Tracker]
        BP[Merged Branch Pruner]
    end

    subgraph Locked Managed Worker Fleet (pollCadence: 0)
        J["[Orchestrated] Jules Async Worker (Cloud)"]
        V["[Orchestrated] Vibe Local Worker (ACP)"]
        AGY["[Orchestrated] Antigravity Local Worker (ACP)"]
        CR["[Orchestrated] Code Reviewer (Token-Friendly)"]
    end

    P <-->|2-Way Markdown & State Sync| O
    O --> FL
    FL -->|Provisions & Locks (pollCadence: 0)| J
    FL -->|Provisions & Locks (pollCadence: 0)| V
    FL -->|Provisions & Locks (pollCadence: 0)| AGY
    FL -->|Provisions & Locks (pollCadence: 0)| CR

    O --> DAG
    DAG --> PL
    PL --> INV
    O --> SPLIT
    SPLIT --> REF
    O --> QA
    O --> COST
    O --> RPR
    O --> BP
    
    O -->|1-Click Approval Granted| J
    O -->|1-Click Approval Granted| V
    O -->|1-Click Approval Granted| AGY
    
    J -->|PR Green CI -> in_review| REV
    REV -->|Direct GitHub PR Comment| GH["GitHub PR Thread (gh pr comment)"]
```

---

## 📦 Packages in Monorepo

| Package | Directory | Description |
|---|---|---|
| **`@pilleo/paperclip-adapter-common`** | [`packages/common`](./packages/common) | Shared protocol types, linter, planning engine, blast radius extractor, zero-dependency TS code investigation, and skills materializer. |
| **`@pilleo/paperclip-orchestrator-adapter`** | [`packages/orchestrator`](./packages/orchestrator) | Multi-lane scheduler, auto-provisioned managed fleet, AST method-level DAG, QA clarification firewall, strong model reviewer, daily cost tracker, and live telemetry. |
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
- The operator retains 100% authority over code execution. Tasks remain safely staged in `backlog` / `todo` until an operator approves execution via Paperclip Board Approval cards enriched with direct issue links and target symbol tables.

### 3. ✂️ Task Granularity, Autonomous Splitting & Pre-Refactoring Gate
- During initial task review, broad tasks spanning multiple modules or epics are autonomously split into sequential sub-tasks with explicit dependency links.
- Before functional code is built, the review inspects existing code complexity: if legacy code is tangled, a **preparatory refactoring sub-task** is spun off first (*"Make the change easy, then make the easy change"*).

### 4. 🛡️ Autonomous Q&A Clarification Firewall
- Intercepts worker questions and uses strong models (Grok, Gemini, GPT-4o, Claude) to autonomously resolve trivial/spec-covered questions. If confidence is low or genuine ambiguity exists, it gracefully escalates to the operator via Paperclip feedback cards.

### 5. 🔍 Token-Efficient Strong Model PR Reviews with Direct GitHub Comments
- Evaluates green-CI PRs using compact surgical diffs against security/kernel invariants.
- Formats structured review cards and posts them directly onto the **GitHub PR thread** (`gh pr comment <prNumber>`), as well as recording verdicts in Paperclip.

### 6. 💰 Daily Budget & Cost Optimization Tracker
- Aggregates estimated cloud token spend across Jules and strong model reviews.
- Displays live budget usage in the Paperclip Telemetry Dashboard and prevents quota overruns.

---

## 🛠️ Developer Commands & CI Pipeline

```bash
# Install all dependencies across workspace
pnpm install

# Typecheck and build all 5 packages
pnpm -r build

# Run all unit and integration tests across monorepo
pnpm -r test

# Run the deep ephemeral live E2E lifecycle test against Paperclip
pnpm test:e2e

# Package all verified production tarballs for release/deployment
pnpm release:pack
```

Distribution packages are validated and output directly to `dist-packages/*.tgz`.
