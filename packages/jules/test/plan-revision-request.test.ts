import { describe, expect, it } from "vitest";
import {
  createPlanRevisionRequest,
  decidePlanRevisionRequestDelivery,
  planRevisionRequestPrompt,
} from "../src/server/plan-revision-request.js";

describe("native plan-review replan request", () => {
  const request = createPlanRevisionRequest({
    interactionId: "expired-terra-card",
    planActivityId: "plan-1",
  });

  it("uses the terminal card identity as a deterministic operational command", () => {
    expect(planRevisionRequestPrompt(request)).toContain(
      "[paperclip-plan-cycle:expired-terra-card]",
    );
  });

  it("retains typed reviewer feedback in the durable command", () => {
    const rejected = createPlanRevisionRequest({
      interactionId: "rejected-luna-card",
      planActivityId: "plan-2",
      reviewerFeedback: "Add the missing regression test.",
    });

    expect(planRevisionRequestPrompt(rejected)).toContain("Add the missing regression test.");
    expect(decidePlanRevisionRequestDelivery({
      request: rejected,
      activities: [{ id: "echo-2", userMessaged: { userMessage: planRevisionRequestPrompt(rejected) } }],
      terminalProviderState: false,
    })).toEqual({ action: "record_delivery" });
  });

  it("accepts only the exact typed Jules echo as delivery evidence", () => {
    expect(decidePlanRevisionRequestDelivery({
      request,
      activities: [{ id: "echo-1", userMessaged: { userMessage: planRevisionRequestPrompt(request) } }],
      terminalProviderState: false,
    })).toEqual({ action: "record_delivery" });

    expect(decidePlanRevisionRequestDelivery({
      request,
      activities: [{ id: "foreign-1", userMessaged: { userMessage: `${planRevisionRequestPrompt(request)} extra` } }],
      terminalProviderState: false,
    })).toEqual({ action: "await_echo" });
  });

  it("waits rather than resending when delivery is ambiguous", () => {
    expect(decidePlanRevisionRequestDelivery({ request, activities: [], terminalProviderState: false })).toEqual({ action: "await_echo" });
  });

  it.each([
    [false, { action: "await_provider_progress" }],
    [true, { action: "start_branch_bound_recovery" }],
  ] as const)("uses provider terminal state after a delivered command: terminal=%s", (terminalProviderState, expected) => {
    expect(decidePlanRevisionRequestDelivery({
      request: { ...request, state: "delivered" },
      activities: [],
      terminalProviderState,
    })).toEqual(expected);
  });
});
