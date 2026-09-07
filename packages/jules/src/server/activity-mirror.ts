import { JulesActivity, JulesClient } from "./jules-client.js";
import { JulesAdapterSessionV1 } from "./session.js";
import { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { formatActivityForLog, activityComment, MAX_COMMENT_LENGTH } from "./activity-formatter.js";
import { normalizeActivities } from "./activity-checkpoint.js";
import { advanceActivityCursor, selectUndeliveredActivities } from "./activity-reconciliation.js";
import { addJulesActivityComment } from "./paperclip-client.js";

/**
 * Jules activity pages are newest-first but provider questions can be older
 * than later plan/review churn. Keep the scan bounded while allowing the
 * reconciliation state machine to discover such questions.
 */
export const MAX_ACTIVITY_PAGES = 20;
// Jules can place an unanswered message after substantial plan/review churn.
// With the bounded 20-page scan, requesting its supported 100-item page is
// necessary to reach that message without turning a heartbeat into an
// unbounded provider poll. The token/signature guards below remain the safety
// boundary for malformed pagination.
const ACTIVITY_PAGE_SIZE = 100;

/**
 * A stored adjudication owns a specific provider question already. During that
 * wait, only a recent page is needed for liveness/progress; replaying the
 * complete historical transcript burns the heartbeat budget and can prevent
 * the scheduled poll from completing. Deep scans remain necessary only when
 * discovering an unowned provider question.
 */
export function activityScanPageLimit(session: JulesAdapterSessionV1): number {
  switch (session.pendingInteraction?.type) {
    case "agent_adjudication":
      return 1;
    case "user_feedback":
    case "plan_approval":
    case "plan_agent_review":
    case "plan_native_review":
    case "completion_confirmation":
    case undefined:
      return MAX_ACTIVITY_PAGES;
  }
}

/**
 * Paginates and retrieves all activities for a Jules session.
 */
export async function listAllActivities(
  client: JulesClient,
  sessionId: NonNullable<JulesAdapterSessionV1["julesSessionId"]>
  , maxPages = MAX_ACTIVITY_PAGES,
): Promise<JulesActivity[]> {
  const activities: JulesActivity[] = [];
  let pageToken: string | undefined;
  const seenPageTokens = new Set<string>();
  const seenPageSignatures = new Set<string>();
  // Keep one heartbeat bounded even for a very long-lived Jules session while
  // still scanning enough small pages to reach late provider questions. Jules
  // activity ordering is not a reliable freshness signal: a question can be
  // emitted before a later completion event, so relying on only the first page
  // would recreate the terminal-race bug this reconciliation protects.
  let pageCount = 0;
  do {
    // A provider-side pagination bug must not turn one heartbeat into an
    // unbounded request loop. Jules occasionally returns the same token at
    // the end of a completed activity stream; retain the page already fetched
    // and stop at the repeated token (or a defensive hard limit).
    if (pageToken && seenPageTokens.has(pageToken)) break;
    if (pageToken) seenPageTokens.add(pageToken);
    pageCount += 1;
    // Smaller pages keep deep Jules cursors under the provider request
    // timeout; the total scan remains bounded by MAX_ACTIVITY_PAGES.
    const page = await client.getActivities(sessionId, pageToken, ACTIVITY_PAGE_SIZE);
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
  maxPages = MAX_ACTIVITY_PAGES,
): Promise<JulesActivity[]> {
  const activities = await listAllActivities(client, session.julesSessionId!, maxPages);
  const delivered = new Set(session.deliveredActivityIds ?? []);
  const deliveredThisRun: JulesActivity[] = [];
  for (const activity of selectUndeliveredActivities(activities, session.activityCheckpoint, [...delivered])) {
    // `sendMessage` is reflected by Jules as a userMessaged activity. It is
    // our own outbound command, not provider progress and must not be copied
    // back into the Paperclip issue on the next poll. Checkpoint it so old
    // outbound prompts do not get reconsidered forever.
    if (activity.userMessaged) {
      delivered.add(activity.id);
      deliveredThisRun.push(activity);
      continue;
    }
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
