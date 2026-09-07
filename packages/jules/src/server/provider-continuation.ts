import type { JulesActivity } from "./jules-client.js";

export type ProviderContinuation =
  | {
      readonly deliveryId: string;
      readonly state: "sent_awaiting_provider";
      readonly sentAt: string;
    }
  | {
      readonly deliveryId: string;
      readonly state: "provider_acknowledged";
      readonly sentAt: string;
      readonly acknowledgedActivityId: string;
    };

function isProviderActivity(activity: JulesActivity): boolean {
  return Boolean(
    activity.agentMessaged || activity.planGenerated || activity.planApproved ||
    activity.progressUpdated || activity.sessionCompleted !== undefined || activity.sessionFailed,
  );
}

/** Outbound `userMessaged` echoes are delivery evidence, never provider progress. */
export function reconcileProviderContinuation(
  continuation: ProviderContinuation,
  activities: readonly JulesActivity[],
): ProviderContinuation {
  if (continuation.state === "provider_acknowledged") return continuation;
  const sentAt = Date.parse(continuation.sentAt);
  const acknowledgement = activities.find((activity) =>
    isProviderActivity(activity) &&
    typeof activity.createTime === "string" &&
    Date.parse(activity.createTime) > sentAt,
  );
  return acknowledgement
    ? { ...continuation, state: "provider_acknowledged", acknowledgedActivityId: acknowledgement.id }
    : continuation;
}
