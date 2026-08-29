import type { JulesActivity } from "./jules-client.js";

export interface ActivityCheckpoint {
  createTime: string;
  id: string;
}

export const ACTIVITY_OVERLAP_MS = 5 * 60 * 1000;

function timestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function compareActivities(left: JulesActivity, right: JulesActivity): number {
  const leftTime = timestamp(left.createTime);
  const rightTime = timestamp(right.createTime);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
  if (leftTime !== null && rightTime === null) return 1;
  if (leftTime === null && rightTime !== null) return -1;
  return left.id.localeCompare(right.id);
}

/** Normalize provider pages into one deterministic, ID-deduplicated stream. */
export function normalizeActivities(activities: JulesActivity[]): JulesActivity[] {
  const byId = new Map<string, JulesActivity>();
  for (const activity of activities) {
    const previous = byId.get(activity.id);
    // Prefer the most complete/newest representation when an ID occurs twice.
    if (!previous || compareActivities(previous, activity) <= 0) byId.set(activity.id, activity);
  }
  return [...byId.values()].sort(compareActivities);
}

export function checkpointFor(activity: JulesActivity): ActivityCheckpoint | null {
  if (timestamp(activity.createTime) === null) return null;
  return { createTime: activity.createTime!, id: activity.id };
}

export function isAfterCheckpoint(
  activity: JulesActivity,
  checkpoint: ActivityCheckpoint | undefined,
  overlapMs = ACTIVITY_OVERLAP_MS,
): boolean {
  if (!checkpoint) return true;
  const activityTime = timestamp(activity.createTime);
  const checkpointTime = timestamp(checkpoint.createTime);
  // Missing/malformed provider timestamps are handled conservatively and
  // deduplicated by activity ID by the caller.
  if (activityTime === null || checkpointTime === null) return true;
  return activityTime >= checkpointTime - overlapMs;
}

export function laterCheckpoint(
  current: ActivityCheckpoint | undefined,
  activity: JulesActivity,
): ActivityCheckpoint | undefined {
  const candidate = checkpointFor(activity);
  if (!candidate) return current;
  if (!current) return candidate;
  const currentActivity = { id: current.id, createTime: current.createTime } as JulesActivity;
  const candidateActivity = { id: candidate.id, createTime: candidate.createTime } as JulesActivity;
  return compareActivities(currentActivity, candidateActivity) < 0 ? candidate : current;
}
