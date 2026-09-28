import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JulesClient } from "../src/server/jules-client.js";
import { createPlanRevisionRequest, planRevisionRequestPrompt } from "../src/server/plan-revision-request.js";
import { parseChildPlanReviewDescription } from "@pilleo/paperclip-adapter-common";
import { loadKey } from "./qualify-plan-approval.js";

interface RevisionClient {
  sendMessage(sessionId: never, request: { prompt: string }, effect?: { kind: "request_revision"; effectId: string; planActivityId: string }): Promise<unknown>;
  getActivities(sessionId: never, pageToken?: string, pageSize?: number): Promise<{ activities: Array<Record<string, unknown>>; nextPageToken?: string | undefined }>;
  getSession(sessionId: never): Promise<{ state?: string }>;
}
type Manifest = { version: 1; sessionId: string; interactionId: string; planActivityId: string; requestId: string;
  state: "prepared" | "transport_accepted" | "echoed" | "new_plan";
  observedActivityIds: string[]; observedState: string | null };

async function save(destination: string, value: Manifest) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  await rename(temporary, destination);
}

async function read(destination: string): Promise<Manifest | null> {
  let handle;
  try { handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw Error("Cannot read owner-only revision manifest");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw Error("Revision manifest must be owner-only");
    const value = JSON.parse(await handle.readFile("utf8")) as Manifest;
    if (value.version !== 1 || !value.requestId) throw Error("Invalid revision manifest");
    return value;
  } finally { await handle.close(); }
}

export async function qualifyTerminalRevisionStep(input: { client: RevisionClient; manifestPath: string; sessionId: string;
  interactionId: string; planActivityId: string; reason: string; sendAllowed: boolean }): Promise<Manifest> {
  const { client, manifestPath, sessionId, interactionId, planActivityId } = input;
  const request = createPlanRevisionRequest({ interactionId, planActivityId, reviewerFeedback: input.reason });
  const prompt = planRevisionRequestPrompt(request);
  let manifest = await read(manifestPath);
  if (manifest && (manifest.sessionId !== sessionId || manifest.interactionId !== interactionId || manifest.planActivityId !== planActivityId)) {
    throw Error("Revision manifest belongs to a different typed card or provider session");
  }
  const observe = async () => {
    const session = await client.getSession(sessionId as never);
    let token: string | undefined;
    const seen = new Set<string>();
    let complete = false;
    let echo = false;
    let newPlan = false;
    const activityIds: string[] = [];
    for (let index = 0; index < 20; index++) {
      const page = await client.getActivities(sessionId as never, token, 100);
      for (const activity of page.activities) {
        if (typeof activity["id"] === "string") activityIds.push(activity["id"]);
        const message = (activity["userMessaged"] as Record<string, unknown> | undefined)?.["userMessage"];
        echo ||= message === prompt;
        newPlan ||= Boolean(activity["planGenerated"] && activity["id"] !== planActivityId);
      }
      token = page.nextPageToken;
      if (!token) { complete = true; break; }
      if (seen.has(token)) break;
      seen.add(token);
    }
    if (!complete) throw Error("Revision activity history incomplete; outcome cannot be inferred");
    return { echo, newPlan, activityIds, state: session.state ?? null };
  };
  const before = await observe();
  if (!manifest && before.newPlan && !before.echo) throw Error("A newer plan already superseded the reviewed activity");
  if (!manifest) {
    if (!input.sendAllowed) throw Error("Send requires explicit --send and an exact answered typed rejection");
    manifest = { version: 1, sessionId, interactionId, planActivityId, requestId: randomUUID(), state: "prepared",
      observedActivityIds: [], observedState: null };
    await save(manifestPath, manifest);
    if (!before.echo) {
      try { await client.sendMessage(sessionId as never, { prompt }, { kind: "request_revision",
        effectId: `revise:${sessionId}:${planActivityId}:${interactionId}`, planActivityId }); }
      catch { throw Error("Revision transport outcome unknown; do not resend without provider evidence"); }
      manifest.state = "transport_accepted";
      await save(manifestPath, manifest);
    }
  }
  const after = await observe();
  manifest.state = after.echo && after.newPlan ? "new_plan" : after.echo ? "echoed" : manifest.state;
  manifest.observedState = after.state;
  manifest.observedActivityIds = after.activityIds;
  await save(manifestPath, manifest);
  return manifest;
}

async function main() {
  const parent = "0b093375-44f9-422b-90e8-c3ce23b62b19";
  const child = "MAZ-1581";
  const sessionId = "6533218485037147595";
  const api = "http://127.0.0.1:3100/api";
  const get = async (path: string) => {
    const response = await fetch(api + path, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw Error(`Paperclip read failed (${response.status})`);
    return await response.json() as Record<string, unknown>;
  };
  const issue = await get(`/issues/${parent}`);
  const review = await get(`/issues/${child}`);
  const cards = await get(`/issues/${child}/interactions`) as unknown as Array<Record<string, unknown>>;
  const card = cards.length === 1 ? cards[0] : undefined;
  const descriptor = parseChildPlanReviewDescription(review["description"]);
  const result = card?.["result"] as Record<string, unknown> | undefined;
  const items = result?.["items"] as Array<Record<string, unknown>> | undefined;
  const item = items?.[0];
  const target = (card?.["payload"] as Record<string, unknown> | undefined)?.["target"] as Record<string, unknown> | undefined;
  const parentPlan = await get(`/issues/${parent}/documents/plan`);
  const resolvedByRunId = card?.["resolvedByRunId"];
  const sourceRunId = card?.["sourceRunId"];
  const reviewerRun = typeof resolvedByRunId === "string" ? await get(`/heartbeat-runs/${encodeURIComponent(resolvedByRunId)}`) : null;
  const sourceRun = typeof sourceRunId === "string" ? await get(`/heartbeat-runs/${encodeURIComponent(sourceRunId)}`) : null;
  if (issue["status"] !== "blocked" || review["parentId"] !== parent ||
      descriptor?.sessionId !== sessionId || descriptor.activityId === undefined ||
      descriptor.reviewerAgentId !== card?.["addresseeAgentId"] || card?.["status"] !== "answered" ||
      result?.["outcome"] !== "resolved" || result?.["complete"] !== true || items?.length !== 1 ||
      target?.["issueId"] !== parent || target?.["revisionId"] !== descriptor.revisionId ||
      parentPlan["latestRevisionId"] !== descriptor.revisionId ||
      reviewerRun?.["id"] !== resolvedByRunId || reviewerRun["agentId"] !== descriptor.reviewerAgentId ||
      (reviewerRun["contextSnapshot"] as Record<string, unknown> | undefined)?.["issueId"] !== review["id"] ||
      sourceRun?.["id"] !== sourceRunId || sourceRun["agentId"] !== descriptor.bootstrapAgentId ||
      (sourceRun["contextSnapshot"] as Record<string, unknown> | undefined)?.["issueId"] !== review["id"] ||
      item?.["id"] !== "plan" || item["verdict"] !== "reject" || typeof item["reason"] !== "string" ||
      !item["reason"].trim()) throw Error("No exact typed rejection eligible for qualification");
  if (process.argv.includes("--verify")) {
    console.log(JSON.stringify({ sessionId, interactionId: card.id, planActivityId: descriptor.activityId,
      reviewerRunId: resolvedByRunId, sourceRunId, typedRejectionVerified: true }));
    return;
  }
  const key = await loadKey();
  const client = new JulesClient(key);
  const manifestPath = path.join(tmpdir(), "paperclip-jules-terminal-revision-qualification.json");
  const end = Date.now() + 3 * 60_000;
  do {
    const result = await qualifyTerminalRevisionStep({ client, manifestPath, sessionId, interactionId: String(card.id),
      planActivityId: descriptor.activityId, reason: item["reason"], sendAllowed: process.argv.includes("--send") });
    console.log(JSON.stringify({ sessionId: result.sessionId, state: result.state,
      observedState: result.observedState, activityCount: result.observedActivityIds.length }));
    if (result.state === "new_plan") return;
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  } while (Date.now() < end);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(() => { console.error("Terminal revision qualification stopped; no automatic resend. Inspect owner-only manifest."); process.exitCode = 1; });
}
