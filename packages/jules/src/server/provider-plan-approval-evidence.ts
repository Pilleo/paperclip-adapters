import type { JulesActivity } from "./jules-client.js";

/** Confirm an interrupted approval only from the same current provider plan after its persisted attempt. */
export function findApprovedPlanActivity(input: {
  readonly activities: readonly Pick<JulesActivity, "id" | "createTime" | "planGenerated" | "planApproved">[];
  readonly planActivityId: string;
  readonly startedAt: string;
  readonly historyComplete: boolean;
}): string | null {
  if (!input.historyComplete) return null;
  const startedAt = Date.parse(input.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  const currentPlan = [...input.activities].reverse().find((activity) => activity.planGenerated);
  if (!currentPlan || currentPlan.id !== input.planActivityId) return null;
  const planId = currentPlan.planGenerated?.plan?.id;
  const planCreatedAt = Date.parse(currentPlan.createTime ?? "");
  if (!planId || !Number.isFinite(planCreatedAt)) return null;
  return input.activities.find((activity) => activity.planApproved?.planId === planId &&
    Number.isFinite(Date.parse(activity.createTime ?? "")) &&
    Date.parse(activity.createTime ?? "") >= Math.max(startedAt, planCreatedAt))?.id ?? null;
}
