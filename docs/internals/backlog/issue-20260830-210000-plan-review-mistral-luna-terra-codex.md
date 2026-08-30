---
title: "Plan review ladder: Mistral first, Luna if missing, Terra is Codex"
severity: "HIGH"
priority: "high"
status: "open"
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

paperclip_issue_id: "077ae7c5-551f-48a3-8370-f0f0ba15503a"
paperclip_identifier: "MAZ-822"
---

**Context:** Jules plan review mixed up the models. Mistral (Vibe) must be the first cheap reviewer and must not be removed. Luna is only used when Mistral is unavailable. Terra is Codex, not xAI Grok. Grok is a separate xAI adapter.

**Needed:** Keep this contract in `evaluatePlanClarity`: static verifier → Mistral if `MISTRAL_API_KEY` exists → else Luna → Terra via `CODEX_API_KEY`/`OPENAI_API_KEY` (never `GROK_API_KEY`/`XAI_API_KEY`) → human last. Auto-approve only from `terra_codex`. Parametrized tests must prove Mistral is preferred over Luna when both keys exist, and that an xAI key does not create Terra.
