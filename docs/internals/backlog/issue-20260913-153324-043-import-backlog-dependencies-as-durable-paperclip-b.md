---
title: "Import backlog dependencies as durable Paperclip blocker edges"
severity: "HIGH"
status: "open"
priority: high
dependencies:
  - "MAZ-1450"
component: "orchestrator"
orchestrator_managed: true
autonomy: "autonomous"
has_side_effects: true
target_modules:
  - "packages/orchestrator"
target_files:
  - "packages/orchestrator/src/core/backlog-sync.ts"
  - "packages/orchestrator/src/core/parser.ts"
  - "packages/orchestrator/src/server/execute.ts"
target_symbols:
  - "syncBacklogMarkdownToPaperclip"
  - "resolveBacklogIssueCandidates"
open_questions: false

paperclip_issue_id: "d6ceeb59-a90b-47e6-a079-b3e39f7b38f7"
paperclip_identifier: "MAZ-1455"
---

# 🟡 [Severity: HIGH]: Import backlog dependencies as durable Paperclip blocker edges

**Context:**
Backlog frontmatter dependencies are visible to the custom dispatcher but are not persisted as Paperclip blockedByIssueIds. A direct API edge is erased by the next source import, so the board cannot represent or enforce the intended task DAG independently of adapter-local parsing.

**Needed:**
1. Parse source dependency references into a typed dependency reference supporting exact Paperclip UUID, Paperclip identifier, and canonical source backlog id. Resolve only within the same Paperclip project; ambiguous or missing references must remain unresolved and be reported without guessing.
2. During source import, compute the complete canonical `blockedByIssueIds` set and include it in the authoritative Paperclip issue update. Do not rely on adapter-local scheduling metadata as a substitute for the board's durable DAG.
3. Preserve non-source blocker edges owned by other workflows. Replace only the importer-owned dependency subset, identified by a documented marker/metadata contract, so an import cannot erase manual or runtime blockers.
4. Make dependency convergence idempotent: repeated imports with unchanged source must leave both source headers and Paperclip blocker edges unchanged, and removal of a source dependency must remove only its corresponding importer-owned edge.
5. Report unresolved/ambiguous references once per state transition and block fresh scheduling of the affected source task until the dependency graph is valid.

**TDD requirements:**
1. Begin with red tests for source-id, MAZ identifier, and UUID resolution; cross-project collision; unresolved reference; ambiguous reference; preserving an external blocker; source-dependency removal; and duplicate importer passes.
2. Add a server-backed disposable Paperclip lifecycle regression: import a parent and dependent backlog file twice, assert `blockedByIssueIds` survives the second pass, then complete the parent and assert only the dependent becomes eligible.
3. Prove no direct out-of-band API PATCH is necessary for the durable edge to persist.
4. Run focused tests red/green, the orchestrator suite, `pnpm test`, `pnpm build`, adapter reload, and the lifecycle E2E.

**Acceptance criteria:**
- Backlog dependencies are visible and durable in the Paperclip board.
- Import retries cannot erase the dependency DAG.
- An unresolved dependency fails closed instead of allowing an out-of-order task start.

---
<!-- id: issue-20260913-153324-043-import-backlog-dependencies-as-durable-paperclip-b  file: issue-20260913-153324-043-import-backlog-dependencies-as-durable-paperclip-b.md -->
