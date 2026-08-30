---
title: "E2E execute: Mistral first, Luna fallback, Terra Codex, never xAI as Terra"
severity: "HIGH"
priority: "high"
status: "open"
component: "testing"
target_modules: ["packages/jules", "@pilleo/paperclip-jules-adapter"]
target_files:
  - "packages/jules/test/e2e-terra-plan-review.test.ts"
  - "packages/jules/test/plan-reviewer.test.ts"
target_symbols:
  - "execute"
  - "evaluatePlanClarity"
open_questions: false
dependencies:
  - "issue-20260830-210000-plan-review-mistral-luna-terra-codex"

paperclip_issue_id: "4e5aa72c-783a-4951-a27d-f4dc4114053a"
paperclip_identifier: "MAZ-825"
---

**Context:** Plan-ladder e2e still needs to prove the live `execute()` path: Mistral is contacted before Luna when both keys exist; Luna runs only if Mistral is missing; Terra is Codex; `GROK_API_KEY` does not auto-approve.

**Needed:** Add execute-level cases: (1) both Mistral and Luna keys → only Mistral fetch URL is used; (2) Luna-only → Terra still waits for a clean cheap pass; (3) `OPENAI_API_KEY`/`CODEX_API_KEY` is what enables Terra, not `XAI_API_KEY`. Keep the existing invariant and required-policy cases.
