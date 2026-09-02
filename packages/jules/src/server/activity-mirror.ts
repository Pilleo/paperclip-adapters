import { JulesActivity, JulesClient } from "./jules-client.js";
import { JulesAdapterSessionV1 } from "./session.js";
import { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { formatActivityForLog, activityComment, MAX_COMMENT_LENGTH } from "./activity-formatter.js";
import { normalizeActivities } from "./activity-checkpoint.js";
import { advanceActivityCursor, selectUndeliveredActivities } from "./activity-reconciliation.js";
import { addJulesActivityComment } from "./paperclip-client.js";

/**
 * Paginates and retrieves all activities for a Jules session.
 */
export async function listAllActivities(
  client: JulesClient,
  sessionId: NonNullable<JulesAdapterSessionV1["julesSessionId"]>
  , maxPages = 5,
): Promise<JulesActivity[]> {
  const activities: JulesActivity[] = [];
  let pageToken: string | undefined;
  const seenPageTokens = new Set<string>();
  const seenPageSignatures = new Set<string>();
  // Keep one heartbeat bounded even for a very long-lived Jules session. The
  // provider's first pages contain the newest work and are sufficient for
  // terminal/question reconciliation; older history is already checkpointed
  // and will be picked up by later ordinary heartbeats if needed.
  let pageCount = 0;
  do {
    // A provider-side pagination bug must not turn one heartbeat into an
    // unbounded request loop. Jules occasionally returns the same token at
    // the end of a completed activity stream; retain the page already fetched
    // and stop at the repeated token (or a defensive hard limit).
    if (pageToken && seenPageTokens.has(pageToken)) break;
    if (pageToken) seenPageTokens.add(pageToken);
    pageCount += 1;
    const page = await client.getActivities(sessionId, pageToken);
    const pageActivities = page.activities ?? [];
    const pageSignature = pageActivities.map((activity) => activity.id).join("\u0000");
    // Some Jules responses ignore pageToken and return the same page with a
    // newly minted token. A token-only guard cannot catch that variant.
    if (pageToken && seenPageSignatures.has(pageSignature)) break;
    seenPageSignatures.add(pageSignature);
    activities.push(...pageActivities);
    pageToken = page.nextPageToken;
  } while (pageToken && pageCount < maxPages);
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
  maxPages = 5,
): Promise<JulesActivity[]> {
  const activities = await listAllActivities(client, session.julesSessionId!, maxPages);
  const delivered = new Set(session.deliveredActivityIds ?? []);
  const deliveredThisRun: JulesActivity[] = [];
  for (const activity of selectUndeliveredActivities(activities, session.activityCheckpoint, [...delivered])) {
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
        // Do not advance the checkpoint when delivery fails. The previous
        // behavior acknowledged the provider activity after a failed POST,
        // permanently dropping questions during transient Paperclip errors.
        // A later heartbeat must retry the same activity idempotently.
        await onLog?.(
          "stdout",
          `[jules-mirror] comment delivery skipped for activity ${activity.id}: ${String(commentError)}\n`,
        );
        // Preserve ordering: later activities must not advance the high-water
        // mark past an undelivered earlier activity.
        break;
      }
    }
    delivered.add(activity.id);
    deliveredThisRun.push(activity);
  }
  session.activityCheckpoint = advanceActivityCursor(session.activityCheckpoint, deliveredThisRun);
  const deliveredIds = Array.from(delivered);
  session.deliveredActivityIds = deliveredIds.slice(Math.max(0, deliveredIds.length - 200));
  return activities;
}
