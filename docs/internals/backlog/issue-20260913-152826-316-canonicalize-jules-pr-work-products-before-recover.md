---
title: "Canonicalize Jules PR work products before recovery and review"
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
  - "packages/orchestrator/src/core/github-sync.ts"
  - "packages/orchestrator/src/server/execute.ts"
target_symbols:
  - "registeredPullRequestFromIssue"
  - "hasUnreviewedReadyPullRequest"
open_questions: false

paperclip_issue_id: "fd1da94c-ffbf-43fb-bf00-561ba54019b8"
paperclip_identifier: "MAZ-1453"
---

# 🟡 [Severity: HIGH]: Canonicalize Jules PR work products before recovery and review

**Context:**
A completed task can retain a stale non-primary Jules pull-request work product alongside its primary PR. Some recovery predicates inspect any ready-for-review product, risking redundant review or recovery work and unnecessary reviewer spend.

**Needed:**
1. Replace independent scans of arbitrary PR work products with one typed canonical-selection function. Rank only Jules-produced PR products, preferring an exact active-session PR identity, then primary product, then a unique valid fallback; return an explicit ambiguous/no-authoritative state rather than guessing.
2. Route PR matching, ready-for-review detection, native review recovery, merge completion, and work-product normalization through that selector. A non-primary stale product must never reopen an issue, create a reviewer card, or consume reviewer capacity.
3. Preserve non-canonical work products as history. Do not delete them or overwrite a primary product merely because another stale row exists; emit one deduplicated diagnostic when ambiguity requires intervention.
4. Document the canonical-product invariant beside the selector and in the orchestrator README so future recovery work cannot reintroduce any-product scans.

**TDD requirements:**
1. Write red selector tests for: primary merged plus stale non-primary ready-for-review; current-session URL over a conflicting primary product; unique fallback; two equally plausible products; invalid URL; and non-Jules product.
2. Add execute-level regressions proving the MAZ-1434-shaped data cannot schedule review/recovery from the stale PR and that the primary merged PR alone completes the issue.
3. Assert repeated heartbeats produce neither duplicate reviewer wakeups nor duplicate diagnostics.
4. Run focused tests red/green, the full orchestrator suite, `pnpm test`, `pnpm build`, adapter reload, and the disposable lifecycle E2E.

**Acceptance criteria:**
- One issue has one authoritative PR lifecycle input.
- Stale work-product history cannot spend reviewer budget or reopen completed work.
- Ambiguous records fail closed and are observable.

---
<!-- id: issue-20260913-152826-316-canonicalize-jules-pr-work-products-before-recover  file: issue-20260913-152826-316-canonicalize-jules-pr-work-products-before-recover.md -->
