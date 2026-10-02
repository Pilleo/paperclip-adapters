---
title: Adapter-neutral configurable conflict recovery
document_type: design_spec
base_revision: 927d5f5
status: ready_for_implementation
date: 2026-10-02
---

# Configurable Conflict Recovery

## User requirements

The user explicitly set these requirements on 2026-10-02:

1. Conflict recovery defaults to **manual**.
2. AI recovery is explicitly configurable, including **which agent** performs it.
3. **Any Paperclip agent can be selected.** There is no Vibe dependency, adapter-type allowlist, managed-fleet-only restriction, or automatic agent substitution.
4. **Conflict resolution does not require new reviews.** Preserve existing native review decisions and progression; do not restart the review ladder because the PR head changed through conflict repair.

These requirements supersede the earlier draft's Vibe-only implementation and mandatory repaired-head reviews. Vibe is retired and is not an implementation dependency. Historical evidence describing Vibe/fresh-head qualification remains a record of the old workflow, not the target behaviour.

## Configuration

```json
{ "conflictRecoveryMode": "manual" }
```

```json
{
  "conflictRecoveryMode": "agent",
  "conflictRecoveryAgentId": "selected-paperclip-agent-id"
}
```

| Mode | Recovery behaviour |
| --- | --- |
| `manual` | Report the conflict and wait for external resolution. No automatic recovery Git writes or AI dispatch. |
| `git_only` | Attempt deterministic clean integration in an isolated checkout. If conflicts remain, wait for manual resolution. |
| `agent` | Dispatch conflict repair to exactly the configured agent through its normal Paperclip execution/provider lifecycle. |

Missing mode means manual. Setting an agent ID alone does not enable AI. A configured ID may remain stored while mode is manual or git-only; require it when agent mode is enabled. Reject malformed modes and blank IDs where a selector is provided.

The selector accepts any agent in the company, including independent agents and agents backed by local or remote adapters. Resolve the exact ID and validate company membership. Do not infer suitability from its name, role, worker key, or adapter type. Actual run admission/access failures stay visible; busy or paused agents wait without choosing another agent.

Configuration belongs to the orchestrator and is propagated to its project runs. Never PATCH the selected agent's shared configuration to switch its workspace or replace its provider settings.

## Adapter-neutral execution

Use a normal native repair task/run addressed to the configured agent. The assignment identifies the original issue/product/PR, existing head/base refs, expected SHAs, and repair-attempt ID. Its instruction is to resolve conflicts on that existing PR and report/publish the resulting head.

The selected adapter owns how it executes the task: local workspace execution, remote provider continuation/session, or another supported Paperclip adapter. Do not require every agent to use ACP, a local clone, a Vibe-specific result shape, or an orchestrator-only publication mechanism. A remote agent can use its own provider tools to update the existing PR. A repair task may have its own provider session where that is the selected adapter's normal lifecycle; it must not replace the original implementation session or create a replacement PR.

Use existing native task/run dispatch and provider lifecycle helpers. Any missing generic assignment/repair support belongs in that shared path or the selected adapter's normal lifecycle; never solve it by restricting the selector to one adapter. Contract tests must prove local and remote execution routes.

Persist the attempt before admission. Bind completion to the selected agent's actual task/run or durable provider result plus independent remote PR observations. Repeated heartbeats, restart, or lost acknowledgement must not dispatch duplicate repair tasks or replay a published head. Normal comments and model prose are not completion receipts.

Deterministic Git operations use an isolated owned checkout, bounded commands, and an explicit expected-head push lease. Agent-backed operations follow their provider's workspace/publication lifecycle and must preserve the original PR and unrelated work. Record the actual publication actor rather than falsely attributing every push to the orchestrator.

## Review continuity after conflict repair

Keep existing native review cards, verdicts, and stage progress. Conflict repair never creates replacement Luna/strong review cards or invalidates an already accepted verdict solely because of the repair head change.

Store repair provenance separately from review evidence:

```ts
interface ConflictResolutionReceipt {
  readonly attemptId: string;
  readonly prUrl: string;
  readonly previousHeadSha: string;
  readonly resolvedHeadSha: string;
  readonly baseSha: string;
  readonly agentId: string | null;
  readonly repairTaskId: string | null;
  readonly runId: string | null;
}
```

Preserve the head actually reviewed in each original verdict. Do not relabel that verdict as a review of the resolved head. A verified conflict-resolution receipt links the reviewed/progress head to the resolved head and allows existing review/merge progress to continue without re-review. Apply the same rule to manual resolution and deterministic integration.

If ordinary review stages had not yet completed, continue the existing review progression; conflict repair must not introduce extra review stages or restart completed stages. An unrelated later code revision is not automatically a conflict-resolution receipt and follows the existing normal code-change path.

The existing final user merge gate targets the current resolved PR state while displaying the original review and repair provenance. Repair does not approve the user gate, merge the PR, or mark the source done. An approved gate waits for the user's actual standard merge; normal remote-merge reconciliation then completes the product/source and releases dependencies.

## Recovery waits and failures

Manual conflict waits have no human deadline. Reuse the existing native action-needed card/wait mechanism; qualify a generic board action card only if an existing supported conflict wait is unavailable. Acknowledging a card does not itself start AI or resolve the Git conflict.

Record one in-flight attempt per PR head/base identity and inspect settled outcomes before retry. Changing the configured agent must not spawn a competing run while an earlier repair remains active or uncertain. Failed access, uncertain Git state, failed native admission, and incomplete observations produce a visible wait/failure rather than silent fallback.

## Required verification

- Missing/explicit manual configuration performs no recovery Git writes or AI dispatch and preserves its wait across ticks/restart.
- Agent mode selects the exact configured company agent across different adapter types, including an independent local agent and a remote-backed agent. Missing/foreign IDs fail; there is no Vibe fallback.
- Local and remote routes repair the same original PR without replacing the original implementation identity.
- After manual, git-only, or agent repair, the existing review-card IDs, accepted verdicts, and completed stages remain unchanged; no additional conflict-triggered reviewer runs are created.
- The resolved head is independently observed and linked by repair provenance. Original review-head evidence remains unchanged.
- Repeated ticks, restarts, and lost acknowledgements do not duplicate repair tasks or publication.
- The pending user merge gate survives restart; a user standard merge is followed by ordinary source/product completion and dependent release.
- Negative controls detect manual-policy bypass and an erroneous review restart after repair; restored copies complete the positive workflow.

Use real Git and real Paperclip 2026.916.0/PostgreSQL integration. The observation driver remains GET-only after execution starts; provider, reviewer, repair-agent, and user actors perform their normal operations.
