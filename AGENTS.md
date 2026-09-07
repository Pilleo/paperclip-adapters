# Guidelines for AI Coding Agents in paperclip-adapters

Welcome, AI Agent. This repository contains the **Paperclip AI Adapters & Orchestration Monorepo**, responsible for multi-agent fleet scheduling, deterministic state machine transitions, workspace isolation, and PR reconciliation.

Because this project manages autonomous AI coding agents interacting with production-grade backends and kernel sandboxes (`mazewall`), you must adhere strictly to the following boundaries, tools, and engineering standards.

---

## 🚧 Hard Boundaries

**🚫 Never Do:**
*   **Never Post Reviews to Public GitHub PR Threads:** A review decision is valid only when it resolves the addressed native Paperclip verdict card. Do not substitute a normal issue comment, provider message, or session prose for a structured verdict.
*   **Never Use Squash Merges:** All PR merges must use standard merge commits (`gh pr merge --merge`). `--squash` is strictly forbidden.
*   **Never Implement Silent Bypasses:** Never catch exceptions silently or downgrade failures. Fail closed by default.
*   **Never Mock Database Calls in Integration Tests:** Always use real SQLite memory or Postgres instances for state machine and database tests.
*   **Use Memory When Available:** Before inspecting unfamiliar modules, query `agentmemory` for stored invariants, package relationships, and prior resolutions. If the MCP service is unavailable, continue from repository evidence and report the unavailable dependency rather than blocking work.
*   **Persist Durable Lessons:** When fixing a recurring adapter race or discovering a non-obvious API contract, record it via `memory_save` when that service is available.

---

## 🏛️ Code Architecture & Tool Discipline

### 1. Package Structure
*   `packages/orchestrator`: Deterministic state machine, dependency DAG resolution, managed-fleet reconciliation, PR review routing, and work-product linking.
*   `packages/jules`: Durable Google Jules provider-session lifecycle and structured plan/question handling.
*   `packages/vibe` and `packages/antigravity`: Local ACP worker adapters.
*   `packages/common`: Shared Paperclip client types and transport helpers.

### 2. Code Intelligence & Semantic Search
*   **Codanna Code Atlas:** Before opening large files, inspect symbol declarations using `codanna retrieve describe <SymbolName>` or `codanna mcp find_callers <SymbolName>`.
*   **Asynchronous Jules / Worker Sync:** Background Git lifecycle hooks (`post-merge`, `post-checkout`, `post-commit`) automatically invoke `scripts/git_async_indexer.sh` to update the AST symbol index and record commit milestones into `agentmemory`.

---

## 🔄 Development & Testing Protocol

*   **Pnpm Workspaces:** Always run workspace commands using `pnpm`:
    - `pnpm test` — Runs Vitest test suites.
    - `pnpm build` — Typechecks and compiles all packages.
    - `pnpm fleet:doctor` — Pre-flight health checks.
*   **Test-Driven Development (TDD):** Whenever fixing a bug or adding an adapter state, write a failing unit test under `test/` before applying source code changes.
*   **External-adapter reload rule:** A successful TypeScript build does not reload Paperclip. After changing an external adapter, build the affected package, restart the Paperclip server, confirm its startup log loaded the package's `dist/index.js`, and let one orchestrator heartbeat reconcile managed agent configuration before testing a live card.
*   **Native-review recovery rule:** Reuse an existing pending native review card only when its addressed reviewer has no active run. Do not create a replacement card, send a free-text decision, or retry a terminal reviewer run; inspect the run result first and recover through the typed review path.
*   **Clean History via `git-absorb`:** When iterating on adapter features or bugfixes, stage intermediate fixes (`git add -u`) and run `git absorb --and-rebase` to automatically absorb them into the corresponding feature commit, keeping PR histories atomic and free of micro-churn.


## 🛠️ Agent DevKit (ADK) Universal Tooling & Hard Boundaries

- Outline with `./scripts/adkw slice <file-or-class>` (or the file_structure skill) before a full source-file view.
- Before modifying a core symbol, run `./scripts/adkw doctor` then `./scripts/adkw blast-radius <SymbolName>`.
- After edits, hooks run `adk hook` (syntax). Delivery uses `./scripts/adkw guard <file> --stage compile|test|delivery`.
- Scaffold issues with `./scripts/adkw new-issue --title "<title>"` and run `./scripts/adkw check-backlog` before completion.
