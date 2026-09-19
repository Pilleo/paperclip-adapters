import { z } from "zod";
import type { JulesActivity } from "./jules-client.js";

/**
 * Durable, non-review command emitted after a native plan-review card becomes
 * terminal without an addressed reviewer verdict. The interaction id is the
 * command identity: it prevents a restart from inventing another request for
 * the same immutable review cycle.
 */
export const PlanRevisionRequestSchema = z.object({
  interactionId: z.string().min(1),
  planActivityId: z.string().min(1),
  /** Feedback from an addressed typed reviewer, never provider prose. */
  reviewerFeedback: z.string().min(1).optional(),
  state: z.enum(["prepared", "delivered"]),
});

export type PlanRevisionRequest = z.infer<typeof PlanRevisionRequestSchema>;

export type PlanRevisionRequestDeliveryDecision =
  | { readonly action: "record_delivery" }
  | { readonly action: "await_echo" }
  | { readonly action: "await_provider_progress" };

export function createPlanRevisionRequest(input: {
  readonly interactionId: string;
  readonly planActivityId: string;
  readonly reviewerFeedback?: string | undefined;
}): PlanRevisionRequest {
  return { ...input, state: "prepared" };
}

/**
 * This is an adapter operational instruction, not a reviewer verdict. Keep
 * the opaque marker deterministic so only an exact typed `userMessaged` echo
 * can prove delivery after a process restart; provider-authored prose is never
 * inspected as protocol input.
 */
export function planRevisionRequestPrompt(request: Pick<PlanRevisionRequest, "interactionId" | "reviewerFeedback">): string {
  const reason = request.reviewerFeedback
    ? ["The typed plan review returned concrete reviewer feedback.", `Reviewer feedback:\n${request.reviewerFeedback}`]
    : ["Paperclip lost the native plan-review form before a verdict was submitted."];
  return [
    ...reason,
    "Do not begin implementation. Publish a new plan activity so it can enter a new typed review cycle.",
    `[paperclip-plan-cycle:${request.interactionId}]`,
  ].join("\n");
}

export function decidePlanRevisionRequestDelivery(input: {
  readonly request: PlanRevisionRequest;
  readonly activities: readonly JulesActivity[];
  readonly terminalProviderState: boolean;
}): PlanRevisionRequestDeliveryDecision {
  switch (input.request.state) {
    case "delivered":
      // A successful sendMessage response proves only transport acceptance.
      // Jules can retain its previous terminal state briefly after accepting
      // the message and still publish the requested plan asynchronously. The
      // typed activity stream, not that stale aggregate state, is authoritative
      // after delivery. Keep polling this session; creating a replacement here
      // races the new plan and loses the durable plan-review identity.
      return { action: "await_provider_progress" };
    case "prepared":
      return input.activities.some(
        (activity) => activity.userMessaged?.userMessage === planRevisionRequestPrompt(input.request),
      )
        ? { action: "record_delivery" }
        : { action: "await_echo" };
    default:
      return assertNever(input.request.state);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled plan revision request state: ${String(value)}`);
}
