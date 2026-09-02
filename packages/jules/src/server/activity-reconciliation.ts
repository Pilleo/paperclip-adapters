import type { JulesActivity } from "./jules-client.js";
import { isAfterCheckpoint, laterCheckpoint, normalizeActivities, type ActivityCheckpoint } from "./activity-checkpoint.js";

/**
 * Pure high-water-mark selection for provider activity.
 * Delivery code must call this before writing and advance only with the IDs
 * it actually delivered. This keeps provider pagination and Paperclip writes
 * independent and makes restart behavior deterministic.
 */
export function selectUndeliveredActivities(
  activities: readonly JulesActivity[],
  checkpoint: ActivityCheckpoint | undefined,
  deliveredIds: readonly string[],
): JulesActivity[] {
  const delivered = new Set(deliveredIds);
  return normalizeActivities([...activities]).filter(
    (activity) => !delivered.has(activity.id) && isAfterCheckpoint(activity, checkpoint),
  );
}

export function advanceActivityCursor(
  checkpoint: ActivityCheckpoint | undefined,
  delivered: readonly JulesActivity[],
): ActivityCheckpoint | undefined {
  return delivered.reduce<ActivityCheckpoint | undefined>(
    (current, activity) => laterCheckpoint(current, activity),
    checkpoint,
  );
}
