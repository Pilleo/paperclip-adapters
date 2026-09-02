---
title: "Plan review ladder: Mistral first, Luna if missing, Terra is Codex"
severity: "HIGH"
priority: "high"
status: "done"
orchestrator_managed: true
component: "orchestrator"
target_modules: ["packages/jules", "@pilleo/paperclip-jules-adapter"]
target_files:
  - "packages/jules/src/server/plan-reviewer.ts"
  - "packages/jules/src/server/execute.ts"
  - "packages/jules/test/plan-reviewer.test.ts"
  - "packages/jules/test/e2e-terra-plan-review.test.ts"
target_symbols:
  - "createMistralReviewer"
  - "createLunaReviewer"
  - "createCheapReviewer"
  - "createTerraCodexReviewer"
  - "evaluatePlanClarity"
open_questions: false
exclusive: true

paperclip_issue_id: "8c2894f3-193d-45a9-9f3c-a14484e846a4"
paperclip_identifier: "MAZ-833"
---

**Context:** Jules plan review mixed up the models. Mistral (Vibe) must be the first cheap reviewer and must not be removed. Luna is only used when Mistral is unavailable. Terra is Codex, not xAI Grok. Grok is a separate xAI adapter.

**Needed:** Keep this contract in `evaluatePlanClarity`: static verifier → Mistral if `MISTRAL_API_KEY` exists → else Luna → Terra via `CODEX_API_KEY`/`OPENAI_API_KEY` (never `GROK_API_KEY`/`XAI_API_KEY`) → human last. Auto-approve only from `terra_codex`. Parametrized tests must prove Mistral is preferred over Luna when both keys exist, and that an xAI key does not create Terra.

**Done:** 
- Implementation in `plan-reviewer.ts` (commit 82a42df): correct ladder with Mistral first, Luna fallback, Terra via Codex keys only
- `createCheapReviewer` returns `createMistralReviewer(env) ?? createLunaReviewer(env)`
- `createTerraCodexReviewer` uses `CODEX_API_KEY || OPENAI_API_KEY` (never GROK/XAI keys)
- Auto-approve only from `terra_codex` stage with clear verdict
- Parametrized tests added (commit 4140dcf): 18 tests in plan-reviewer.test.ts, 6 tests in e2e-terra-plan-review.test.ts
- All 24 tests pass, proving Mistral preference over Luna and xAI keys don't create Terra
