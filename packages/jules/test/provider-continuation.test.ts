import { describe, expect, it } from "vitest";
import { reconcileProviderContinuation } from "../src/server/provider-continuation.js";

const sent = {
  deliveryId: "native-review:card-1:sha-1",
  state: "sent_awaiting_provider" as const,
  sentAt: "2026-09-06T10:00:00.000Z",
};

describe("provider continuation", () => {
  it("does not mistake Jules' reflection of our outbound message for provider progress", () => {
    expect(reconcileProviderContinuation(sent, [{
      id: "outbound-1", createTime: "2026-09-06T10:00:01.000Z", userMessaged: { userMessage: "Fix it." },
    }])).toEqual(sent);
  });

  it.each([
    [{ id: "progress-1", createTime: "2026-09-06T10:00:02.000Z", progressUpdated: { title: "Working" } }],
    [{ id: "question-1", createTime: "2026-09-06T10:00:02.000Z", agentMessaged: { agentMessage: "Which module?" } }],
    [{ id: "plan-1", createTime: "2026-09-06T10:00:02.000Z", planGenerated: { plan: { id: "plan" } } }],
  ])("acknowledges only a newer provider-originated activity %#", (activity) => {
    expect(reconcileProviderContinuation(sent, [activity])).toEqual({
      ...sent,
      state: "provider_acknowledged",
      acknowledgedActivityId: activity.id,
    });
  });

  it("does not acknowledge historical activity from before delivery", () => {
    expect(reconcileProviderContinuation(sent, [{
      id: "old-1", createTime: "2026-09-06T09:59:59.000Z", agentMessaged: { agentMessage: "Old question" },
    }])).toEqual(sent);
  });
});
