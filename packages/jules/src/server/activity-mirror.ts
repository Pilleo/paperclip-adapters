import { JulesActivity, JulesClient } from "./jules-client.js";
import { JulesAdapterSessionV1 } from "./session.js";
import { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { formatActivityForLog, activityComment, MAX_COMMENT_LENGTH } from "./activity-formatter.js";
import { isAfterCheckpoint, laterCheckpoint, normalizeActivities } from "./activity-checkpoint.js";
import { addJulesActivityComment } from "./paperclip-client.js";

/**
 * Paginates and retrieves all activities for a Jules session.
 */
export async function listAllActivities(
  client: JulesClient,
  sessionId: NonNullable<JulesAdapterSessionV1["julesSessionId"]>
): Promise<JulesActivity[]> {
  const activities: JulesActivity[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.getActivities(sessionId, pageToken);
    activities.push(...(page.activities ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return normalizeActivities(activities);
}

/**
 * Mirrors new activities from Jules cloud session to Paperclip log and issue comments.
 */
export async function mirrorNewActivities(
  client: JulesClient,
  session: JulesAdapterSessionV1,
  taskId: string,
  authToken: string | undefined,
  runId: string | undefined,
  onLog: AdapterExecutionContext["onLog"] | undefined,
): Promise<JulesActivity[]> {
  const activities = await listAllActivities(client, session.julesSessionId!);
  const delivered = new Set(session.deliveredActivityIds ?? []);
  for (const activity of activities) {
    if (!isAfterCheckpoint(activity, session.activityCheckpoint) || delivered.has(activity.id)) continue;
    if (onLog) {
      const logLine = formatActivityForLog(activity);
      await onLog("stdout", logLine);
    }
    const rawBody = activityComment(activity);
    const body =
      rawBody && rawBody.length > MAX_COMMENT_LENGTH
        ? rawBody.slice(0, MAX_COMMENT_LENGTH) + "\n…[truncated]"
        : rawBody;
    if (body) {
      try {
        await addJulesActivityComment(taskId, activity.id, body, session.julesSessionUrl, authToken, runId);
      } catch (commentError) {
        await onLog?.(
          "stdout",
          `[jules-mirror] comment delivery skipped for activity ${activity.id}: ${String(commentError)}\n`,
        );
      }
    }
    delivered.add(activity.id);
    session.activityCheckpoint = laterCheckpoint(session.activityCheckpoint, activity);
  }
  const deliveredIds = Array.from(delivered);
  session.deliveredActivityIds = deliveredIds.slice(Math.max(0, deliveredIds.length - 200));
  return activities;
}
