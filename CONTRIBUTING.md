# 🛡️ Contributing Guidelines & Architectural Invariants

Welcome to the **Paperclip AI Adapters & Orchestration Monorepo**.

Because this project manages autonomous AI coding agents interfacing with kernel-level security libraries (`mazewall`), all contributors (human and AI agents) must strictly adhere to the following architectural rules and engineering philosophies.

---

## 🏛️ The Golden Invariants (Non-Negotiable Rules)

### 1. 🚫 Never Post Reviews to Public GitHub PR Threads
- Reviews, verdict summaries, and questions must **never** be posted to public GitHub PR comments.
- All review verdicts live in Paperclip issue comments and are relayed directly into the worker's session context (`client.sendMessage`).

### 2. 🚫 Never Use Squash Merges (`--squash` is Forbidden)
- All automated PR merges must use standard merge commits (`gh pr merge --merge`).
- Squashing destroys commit lineage and causes branch conflicts across concurrent AI workstreams.

### 3. 🚫 Zero Silent Bypasses & Fail Closed by Default
- Never catch exceptions (`EPERM`, `EACCES`, adapter errors) without rethrowing or failing closed.
- Never write simulated recovery mocks or silent bypass modes (`SILENT_BYPASS`).

### 4. 🚫 No Test Disabling, Removal, or Coverage Decreases
- Reviewers and contributors must strictly reject any added `@Disabled`, `@Ignore`, commented-out assertions, or deleted tests (unless explicitly justified by an obsolete removed API).
- Test coverage and behavioral assertions must never decrease.

### 5. 🚫 No Dummy / Weakened Tests
- Reject tests that only verify collection lengths or `entryCount` without actually exercising behavioral, containment, or security paths.

---

## 🏗️ Code Design Principles

### 1. Pure State Machines & Intent Separation
- Business logic, scheduling decisions, and state machine transitions must be implemented as **pure functions** (e.g. `state-engine.ts`, `review-pipeline.ts`, `dispatcher.ts`, `agent-health-monitor.ts`).
- Network I/O, API calls, and process execution must be decoupled into atomic executors that consume the plans produced by pure functions.

### 2. Compile-Time Type Discipline
- Model Paperclip prerequisites as strongly typed invariants (e.g. `InReviewDisposition`, `InProgressDisposition` in `disposition.ts`) to prevent HTTP 422 errors before sending network requests.

### 3. Test-Driven Development (TDD)
- Every bugfix and feature must include automated unit tests under `test/`.
- Verify your changes by running:
  ```bash
  pnpm test
  pnpm build
  ```

---

## 📋 Pull Request Checklist Before Merging

- [ ] All unit tests pass cleanly: `pnpm test`.
- [ ] TypeScript builds with zero errors: `pnpm build`.
- [ ] No public GitHub PR review comments are posted.
- [ ] PR merge strategy is set to standard merge commit (`--merge`).
- [ ] Pre-flight doctor reports all green: `pnpm fleet:doctor`.
