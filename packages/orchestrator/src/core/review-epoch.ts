/**
 * Pure state machine for one immutable PR-review epoch.
 *
 * An epoch is identified by issue, PR URL, head SHA, and stage. Runtime
 * execution state is deliberately not the lock: Paperclip may rebuild it as
 * idle after a restart. The pending native card plus this bounded recovery
 * lease are the durable coordination state, so a heartbeat cannot turn a
 * lost run into an unbounded reviewer-wake loop.
 */

export type ReviewEpochStage = string;

export type ReviewEpochObservation = {
  readonly issueId: string;
  readonly prUrl: string;
  readonly headSha: string;
  readonly stage: ReviewEpochStage;
  /** Next configured ladder stage; null means this is the final reviewer. */
  readonly nextStage: ReviewEpochStage | null;
  readonly reviewerAgentId: string;
  readonly card:
    | { readonly state: "missing" }
    | { readonly state: "pending"; readonly id: string }
    | { readonly state: "answered"; readonly id: string }
    | { readonly state: "retired"; readonly id: string; readonly reason: string };
  readonly reviewerRun:
    | { readonly state: "missing" }
    | { readonly state: "active"; readonly runId: string }
    | { readonly state: "finished"; readonly runId: string }
    | { readonly state: "failed"; readonly runId: string; readonly reason: string };
  readonly recovery:
    | { readonly state: "never_attempted" }
    | { readonly state: "active" }
    | { readonly state: "leased"; readonly leaseId?: string }
    | { readonly state: "failed"; readonly reason: string };
  readonly verdict:
    | {
        readonly cardId: string;
        readonly headSha: string;
        readonly decision: "all_good" | "needs_work";
        readonly reason?: string;
      }
    | null;
  readonly comments?: readonly { readonly body: string }[];
  readonly assignedReviewer?: string | null;
};

export type ReviewEpochDecision =
  | { readonly action: "create_card"; readonly stage: ReviewEpochStage }
  | { readonly action: "wake_once"; readonly stage: ReviewEpochStage }
  | { readonly action: "await_verdict"; readonly stage: ReviewEpochStage }
  | { readonly action: "advance"; readonly nextStage: ReviewEpochStage }
  | { readonly action: "complete"; readonly stage: ReviewEpochStage }
  | { readonly action: "reassign_worker"; readonly stage: ReviewEpochStage; readonly reason: string }
  | { readonly action: "escalate"; readonly stage: ReviewEpochStage; readonly reason: string };

export function reduceReviewEpoch(input: ReviewEpochObservation): ReviewEpochDecision {
  // Provider comments and assignment are intentionally not inputs to the
  // transition. Only the exact structured verdict for this card and head can
  // move a review epoch forward.
  const verdictMatches = input.verdict !== null &&
    input.card.state === "answered" &&
    input.verdict.cardId === input.card.id &&
    input.verdict.headSha === input.headSha;

  switch (input.verdict?.decision) {
    case "needs_work":
      if (verdictMatches) {
        return {
          action: "reassign_worker",
          stage: input.stage,
          reason: input.verdict.reason ?? "Structured reviewer requested changes.",
        };
      }
      break;
    case "all_good":
      if (verdictMatches) {
        return input.nextStage
          ? { action: "advance", nextStage: input.nextStage }
          : { action: "complete", stage: input.stage };
      }
      break;
    case undefined:
      break;
  }

  switch (input.recovery.state) {
    case "failed":
      return { action: "escalate", stage: input.stage, reason: input.recovery.reason };
    case "never_attempted":
    case "active":
    case "leased":
      break;
  }

  switch (input.reviewerRun.state) {
    case "failed":
      return { action: "escalate", stage: input.stage, reason: input.reviewerRun.reason };
    case "missing":
    case "active":
    case "finished":
      break;
  }

  switch (input.card.state) {
    case "retired":
      // A card can be retired by orchestration itself while an upstream gate
      // (for example Jules plan approval) is still pending. Once that gate is
      // satisfied, the retired card is not evidence that a human must repair
      // the task: with no live reviewer run or recovery lease, allocate one
      // replacement card. The durable pending replacement then makes the
      // next heartbeat idempotently wait instead of creating another card.
      switch (input.reviewerRun.state) {
        case "active":
          return { action: "escalate", stage: input.stage, reason: input.card.reason };
        case "missing":
        case "finished":
          return input.recovery.state === "never_attempted"
            ? { action: "create_card", stage: input.stage }
            : { action: "escalate", stage: input.stage, reason: input.card.reason };
      }
    case "missing":
      return { action: "create_card", stage: input.stage };
    case "pending":
      switch (input.reviewerRun.state) {
        case "missing":
          switch (input.recovery.state) {
            case "never_attempted":
              return { action: "wake_once", stage: input.stage };
            case "leased":
            case "active":
          }
          break;
        case "active":
          break;
        case "finished":
          // Codex can complete its outer turn after the MCP bridge returns a
          // typed infrastructure error. A pending card is proof that no
          // verdict was committed, so recover that immutable card under the
          // terminal run's idempotency key rather than waiting indefinitely.
          return input.recovery.state === "never_attempted"
            ? { action: "wake_once", stage: input.stage }
            : { action: "await_verdict", stage: input.stage };
      }
      break;
    case "answered":
      break;
  }

  return { action: "await_verdict", stage: input.stage };
}
