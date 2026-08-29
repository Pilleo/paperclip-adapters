# 📎 Paperclip Adapters Suite

Production-grade, deterministic, multi-agent adapters for **[Paperclip AI](https://github.com/paperclipai/paperclip)**. 

This repository contains the complete adapter monorepo that connects Paperclip's control-plane with **Google Jules (Cloud Async Developer)**, **Mistral Vibe (Local ACP Developer)**, **Google Antigravity (Local ACP Developer)**, and a **Deterministic Multi-Lane Task Orchestrator**.

---

## 🏛️ System Architecture

```mermaid
flowchart TD
    subgraph Control Plane (Paperclip Core)
        P[Paperclip API / Kanban Board]
        AP[Operator Approval Gate]
        IA[Interactive Reply Cards]
    end

    subgraph Orchestration Layer (@pilleo/paperclip-orchestrator-adapter)
        O[Deterministic Orchestration Tick]
        DAG[Method-Level DAG Conflict Matrix]
        PL[Deterministic Planning & Codanna Blast Radius Engine]
        INV[Pluggable Invariant Engine]
        RPR[Stalled-Session Auto-Reaper]
        CLR[Autonomous Clarifier Q&A Loop]
    end

    subgraph Worker Lanes
        J[Google Jules Cloud Adapter]
        V[Mistral Vibe Local ACP Adapter]
        AGY[Google Antigravity Local ACP Adapter]
        REV[Code Reviewer Agent]
    end

    P <-->|2-Way Markdown & State Sync| O
    O --> DAG
    DAG --> PL
    PL --> INV
    O --> RPR
    O --> CLR
    
    O -->|Cloud Async Lane (Max 15)| J
    O -->|Local ACP Lane (Max 2)| V
    O -->|Local ACP Lane (Max 2)| AGY
    O -->|Review Routing| REV

    J -->|PR Created| P
    V -->|PR Created| P
    AGY -->|PR Created| P
```

---

## 📦 Monorepo Packages

| Package | Role | Description |
|---|---|---|
| [`@pilleo/paperclip-orchestrator-adapter`](./packages/orchestrator) | **Control Plane** | Deterministic scheduling, method-level DAG locks, stalled session reaping, remote PR reconciliation, and operator approval gating. |
| [`@pilleo/paperclip-jules-adapter`](./packages/jules) | **Cloud Worker** | Google Jules integration with checkpoint restart recovery, interactive Q&A reply cards, and rich UI step accordions. |
| [`@pilleo/paperclip-vibe-adapter`](./packages/vibe) | **Local Worker** | Mistral Vibe ACP execution engine running locally via stdio with materialized skills. |
| [`@pilleo/paperclip-antigravity-adapter`](./packages/antigravity) | **Local Worker** | Google Antigravity ACP execution engine running locally via stdio with materialized skills. |
| [`@pilleo/paperclip-adapter-common`](./packages/common) | **Core Utilities** | Language-agnostic planning engine, Codanna symbol research, blast-radius test discovery, and skills materializer. |

---

## 🔑 Core Capabilities & Invariants

### 1. ⚡ Method-Level DAG Concurrency Matrix
Instead of locking entire directories or modules, the orchestrator constructs a **fine-grained AST dependency DAG**:
- Tasks modifying disjoint methods in the same file run **concurrently in parallel**.
- Tasks modifying overlapping methods or constructors are queued in `todo` until active PRs merge.
- Active GitHub PRs dynamically lock their modified files and symbols in the conflict matrix.

### 2. 🔬 Caller-Impact Blast Radius Calculation (Codanna)
- Parses target symbol AST definitions and caller graphs (`codanna retrieve describe <Symbol>`).
- Automatically extracts all downstream test suites (`*Test.kt`, `*.test.ts`, `*_test.go`, `*_test.rs`, `test_*.py`) that call the modified code.
- Directly embeds the exact blast-radius test suites into worker prompts to ensure thorough regression verification.

### 3. 🛡️ Pluggable Invariant Engine (`.paperclip/invariants.json`)
- **Universal Default Hygiene:** Scans for unresolved Git merge conflict markers (`<<<<<<< HEAD`) and raw private keys.
- **Custom Project Scopes:** Loads declarative regex rules from workspace `.paperclip/invariants.json` with file-extension filtering (`.kt`, `.rs`, `.go`, `.tsx`, `.ts`).

### 4. ♻️ Self-Healing Stalled-Session Reaper
- Automatically runs during each orchestrator tick.
- If a task is left in `in_progress` without an active runner or heartbeat for $> 15\text{ minutes}$, it resets the task to `todo`, unlocks all held files, and logs an audit comment.

### 5. ❓ Two-Way Autonomous Clarifier Q&A Loop
- When tasks have ambiguous requirements or open questions, the clarifier first queries Codanna and workspace files to resolve them autonomously.
- Only if the codebase cannot answer does it escalate a 1-click interactive reply card to the human operator.

### 6. 🔒 Operator Start-Approval Gate
- High-impact tasks are trapped in `todo`/`backlog` until approved via a 1-click Paperclip Board Approval card (`POST /api/companies/:id/approvals`).

---

## 🛠️ Paperclip Protocol Invariants & Discovered Gotchas

When developing Paperclip adapters, adhere strictly to these core API contracts:

1. **Mandatory Assignee on `in_progress`:**
   - `PATCH /api/issues/:id` with `{ status: "in_progress" }` **strictly requires** an `assigneeAgentId` or `assigneeUserId` (Paperclip returns HTTP 422 otherwise).
2. **Approval Request Enum:**
   - `POST /api/companies/:id/approvals` requires `type: "request_board_approval"` with payload `{ action: "task_start", issueId: ... }`.
3. **Approval Resolution:**
   - Approvals are resolved via `POST /api/approvals/:id/approve` with `{ decisionNote: "..." }`.
4. **Strict PR Word-Boundary Matching:**
   - Low-numbered issues (e.g. `MAZ-2`) must use regex word boundaries (`\bMAZ-2\b`) to prevent false-positive collisions with timestamped issues (e.g. `issue-2026...`).

---

## 🧪 Testing & Verification

### 1. Monorepo Unit & Integration Suite
Runs all 399+ unit tests across all 5 workspace packages:
```bash
pnpm -r build && pnpm -r test
```

### 2. Deep Ephemeral E2E Lifecycle Suite
Executes a 6-phase live lifecycle test against local Paperclip (`http://127.0.0.1:3100`) using an ephemeral isolated company and temporary directory (`os.tmpdir()`), leaving production boards and codebases completely untouched:
```bash
pnpm test:e2e
```

**E2E Phases Verified:**
- **Phase 1:** Ephemeral test company creation & agent registration (`orchestrator`, `jules`, `vibe`).
- **Phase 2:** Live 2-way Markdown backlog ingestion and frontmatter synchronization.
- **Phase 3:** Operator start-approval gate trapping and simulated resolution.
- **Phase 4:** Method-level DAG concurrency (disjoint method tasks run in parallel while overlapping method tasks are held in `todo`).
- **Phase 5:** Codanna AST symbol research and Jules cloud prompt synthesis.
- **Phase 6:** Autonomous clarification protocol resolving open questions from code.
- **Teardown:** Clean deletion of test company and temporary directory.

---

## 📜 License
MIT © Pilleo Engineering
