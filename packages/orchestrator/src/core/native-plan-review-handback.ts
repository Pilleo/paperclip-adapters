import { childPlanReviewKey, isStablePlanReviewChild, parseChildPlanReviewDescription, nativePlanReviewStageId, parsePlanReviewIdempotencyKey } from "@pilleo/paperclip-adapter-common";
import { nativeReviewFetch } from "./native-review-http.js";
import {
  readNativeReviewAssignmentFromRuntime,
  submitNativeReviewVerdictFromRuntime,
  type NativeReviewRuntimeSubmissionInput,
  type NativeReviewAssignmentResult,
  type NativeReviewSubmissionResult,
} from "./native-review-submission.js";

type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface NativePlanReviewHandbackInput {
  readonly apiBase: string;
  readonly issueId: string;
  readonly agentId: string;
  readonly interactionId: string;
  readonly token?: string | undefined;
  readonly runId?: string | undefined;
  readonly fetcher?: Fetcher | undefined;
}

export type NativePlanReviewHandbackResult =
  | { readonly ok: true; readonly interactionId: string; readonly reviewer: "luna" | "terra";
      readonly verdict: "approve" | "reject"; readonly disposition: "returned_to_jules" | "already_returned" }
  | { readonly ok: false; readonly code:
      | "invalid_identity" | "evidence_unavailable" | "invalid_card_evidence" | "untrusted_plan_verdict"
      | "stale_plan_revision" | "unowned_review_policy" | "unexpected_issue_state" | "handback_failed" };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Recover a prior typed verdict before asking a restarted reviewer to decide again. */
export async function readPlanReviewAssignmentAndReconcileHandback(
  input: Omit<NativeReviewRuntimeSubmissionInput, "verdict" | "reason">,
): Promise<NativeReviewAssignmentResult> {
  const assignment = await readNativeReviewAssignmentFromRuntime(input);
  if (assignment.ok || assignment.code !== "no_owned_pending_card" || !input.issueId?.trim() ||
      !input.agentId.trim() || !input.interactionId?.trim()) return assignment;
  const handback = await reconcileAnsweredPlanReviewHandback({
    apiBase: input.apiBase, issueId: input.issueId, agentId: input.agentId,
    interactionId: input.interactionId, token: input.token, runId: input.runId, fetcher: input.fetcher,
  });
  if (handback.ok) return { ok: true, assignment: {
    kind: "plan_handback_recovered", interactionId: handback.interactionId, verdict: handback.verdict,
  } };
  return handback.code === "invalid_card_evidence" ? assignment : handback;
}

export async function reconcileAnsweredPlanReviewHandback(
  input: NativePlanReviewHandbackInput,
): Promise<NativePlanReviewHandbackResult> {
  if (!input.apiBase.trim() || !input.issueId.trim() || !input.agentId.trim() || !input.interactionId.trim() ||
      !input.token?.trim() || !input.runId?.trim()) {
    return { ok: false, code: "invalid_identity" };
  }
  const root = input.apiBase.replace(/\/+$/, "").replace(/\/api$/, "");
  const headers = {
    ...(input.token?.trim() ? { Authorization: `Bearer ${input.token.trim()}` } : {}),
    ...(input.runId?.trim() ? { "X-Paperclip-Run-Id": input.runId.trim() } : {}),
    "Content-Type": "application/json",
  };
  const fetcher = input.fetcher ?? nativeReviewFetch;
  const read = async (path: string): Promise<unknown> => {
    const response = await fetcher(`${root}${path}`, { headers });
    if (!response.ok) throw new Error(`Paperclip evidence request failed (${response.status}) at ${path}`);
    return response.json();
  };
  let issue: Record<string, unknown> | null;
  let card: Record<string, unknown> | null;
  let cardKey: NonNullable<ReturnType<typeof parsePlanReviewIdempotencyKey>>;
  try {
    const [rawIssue, rawCards] = await Promise.all([
      read(`/api/issues/${encodeURIComponent(input.issueId)}`),
      read(`/api/issues/${encodeURIComponent(input.issueId)}/interactions`),
    ]);
    issue = record(rawIssue);
    if (!issue || issue["id"] !== input.issueId || !Array.isArray(rawCards)) {
      return { ok: false, code: "invalid_card_evidence" };
    }
    const cards = rawCards.map(record).filter((candidate): candidate is Record<string, unknown> => candidate !== null);
    card = cards.find((candidate) => candidate["id"] === input.interactionId) ?? null;
    if (!card || card["kind"] !== "request_item_verdicts" || card["status"] !== "answered" ||
        card["addresseeAgentId"] !== input.agentId) return { ok: false, code: "invalid_card_evidence" };
    const targetCard: Record<string, unknown> = card;
    const parsedKey = parsePlanReviewIdempotencyKey(text(targetCard["idempotencyKey"]) ?? "");
    if (!parsedKey || parsedKey.issueId !== input.issueId ||
        cards.some((candidate) => candidate["id"] !== targetCard["id"] && candidate["status"] === "pending" &&
          candidate["kind"] === "request_item_verdicts" && candidate["addresseeAgentId"] === input.agentId &&
          text(candidate["idempotencyKey"])?.startsWith(`jules:plan-review:v2:${input.issueId}:`))) {
      return { ok: false, code: "invalid_card_evidence" };
    }
    cardKey = parsedKey;
    const payload = record(card["payload"]);
    const target = record(payload?.["target"]);
    const result = record(card["result"]);
    const items = Array.isArray(result?.["items"]) ? result["items"] : [];
    const plan = items.length === 1 ? record(items[0]) : null;
    const verdict = plan?.["verdict"];
    const sourceRunId = text(card["sourceRunId"]);
    const verdictRunId = text(card["resolvedByRunId"]);
    if (!verdictRunId) return { ok: false, code: "untrusted_plan_verdict" };
    if (target?.["type"] !== "issue_document" || target["issueId"] !== input.issueId || target["key"] !== "plan" ||
        !text(target["documentId"]) || target["revisionId"] !== cardKey.revisionId ||
        typeof target["revisionNumber"] !== "number" || !Number.isInteger(target["revisionNumber"]) || result?.["outcome"] !== "resolved" ||
        result["complete"] !== true || plan?.["id"] !== "plan" ||
        (verdict !== "approve" && verdict !== "reject") || !sourceRunId) {
      return { ok: false, code: "invalid_card_evidence" };
    }
    if (verdict === "reject" && !text(plan?.["reason"])) return { ok: false, code: "invalid_card_evidence" };

    const [rawDocument, rawSourceRun, rawVerdictRun] = await Promise.all([
      read(`/api/issues/${encodeURIComponent(input.issueId)}/documents/plan`),
      read(`/api/heartbeat-runs/${encodeURIComponent(sourceRunId)}`),
      read(`/api/heartbeat-runs/${encodeURIComponent(verdictRunId)}`),
    ]);
    const document = record(rawDocument);
    const sourceRun = record(rawSourceRun);
    const verdictRun = record(rawVerdictRun);
    if (!document || document["id"] !== target["documentId"] ||
        document["latestRevisionId"] !== cardKey.revisionId ||
        document["latestRevisionNumber"] !== target["revisionNumber"]) {
      return { ok: false, code: "stale_plan_revision" };
    }
    const ownerId = text(sourceRun?.["agentId"]);
    const verdictContext = record(verdictRun?.["contextSnapshot"]);
    const stageContext = record(verdictContext?.["executionStage"]);
    const exactCardBound = verdictContext?.["interactionId"] === input.interactionId;
    const exactStageBound = verdictContext?.["interactionId"] == null &&
      stageContext?.["wakeRole"] === "reviewer" && stageContext["stageType"] === "review" &&
      stageContext["stageId"] === nativePlanReviewStageId(input.issueId, cardKey.revisionId, cardKey.stage) &&
      record(stageContext["currentParticipant"])?.["agentId"] === input.agentId &&
      record(stageContext["returnAssignee"])?.["agentId"] === ownerId;
    if (sourceRun?.["id"] !== sourceRunId || !ownerId || ownerId === input.agentId ||
        record(sourceRun["contextSnapshot"])?.["issueId"] !== input.issueId ||
        verdictRun?.["id"] !== verdictRunId || verdictRun["agentId"] !== input.agentId ||
        verdictContext?.["issueId"] !== input.issueId || !(exactCardBound || exactStageBound)) {
      return { ok: false, code: "untrusted_plan_verdict" };
    }
    if (issue["status"] === "in_progress" && issue["assigneeAgentId"] === ownerId && issue["executionPolicy"] === null) {
      return { ok: true, interactionId: input.interactionId, reviewer: cardKey.stage, verdict,
        disposition: "already_returned" };
    }
    if (issue["status"] !== "in_review" || issue["assigneeAgentId"] !== input.agentId) {
      return { ok: false, code: "unexpected_issue_state" };
    }
    const state = record(issue["executionState"]);
    const policy = record(issue["executionPolicy"]);
    const stages = Array.isArray(policy?.["stages"]) ? policy["stages"] : [];
    const onlyStage = stages.length === 1 ? record(stages[0]) : null;
    const participants = Array.isArray(onlyStage?.["participants"]) ? onlyStage["participants"] : [];
    if (!policy || policy["monitor"] || stages.length !== 1 || !onlyStage || onlyStage["type"] !== "review" ||
        onlyStage["id"] !== nativePlanReviewStageId(input.issueId, cardKey.revisionId, cardKey.stage) ||
        participants.length !== 1 || record(participants[0])?.["agentId"] !== input.agentId ||
        state?.["status"] !== "pending" || state["currentStageId"] !== onlyStage["id"] ||
        state["currentStageType"] !== "review" || record(state["currentParticipant"])?.["agentId"] !== input.agentId ||
        record(state["returnAssignee"])?.["agentId"] !== ownerId) {
      return { ok: false, code: "unowned_review_policy" };
    }
    const response = await fetcher(`${root}/api/issues/${encodeURIComponent(input.issueId)}`, {
      method: "PATCH", headers, body: JSON.stringify({ executionPolicy: null }),
    });
    if (!response.ok) return { ok: false, code: "handback_failed" };
    const restored = record(await response.json());
    return restored?.["id"] === input.issueId && restored["status"] === "in_progress" && restored["assigneeAgentId"] === ownerId
      ? { ok: true, interactionId: input.interactionId, reviewer: cardKey.stage, verdict, disposition: "returned_to_jules" }
      : { ok: false, code: "handback_failed" };
  } catch {
    return { ok: false, code: "evidence_unavailable" };
  }
}

/**
 * Submits a reviewer verdict and, for Jules plan cards only, returns the
 * issue to Jules before reporting success. A restart after a lost verdict
 * response reuses the run-bound interaction to reconcile the handback rather
 * than resubmitting the verdict.
 */
export async function submitPlanVerdictAndReturnToJules(
  input: NativeReviewRuntimeSubmissionInput,
): Promise<NativeReviewSubmissionResult> {
  const submitted = await submitNativeReviewVerdictFromRuntime(input);
  if (submitted.ok && (submitted.planReviewProtocol === "child_v3" || submitted.planReviewProtocol === "child_v4")) {
    try {
      await completeOwnChildPlanReview(input, submitted.childReviewKey, submitted.interactionId);
      return submitted;
    } catch {
      return { ok: false, code: "child_plan_cleanup_failed" };
    }
  }
  switch (submitted.ok) {
    case true: {
      switch (submitted.itemId) {
        case "plan": {
          if (!input.issueId?.trim()) return submitted;
          const handback = await reconcileAnsweredPlanReviewHandback({
            apiBase: input.apiBase,
            issueId: input.issueId,
            agentId: input.agentId,
            interactionId: submitted.interactionId,
            token: input.token,
            runId: input.runId,
            fetcher: input.fetcher,
          });
          switch (handback.ok) {
            case true:
              return submitted;
            case false:
              return { ok: false, code: handback.code };
          }
        }
        default:
          return submitted;
      }
    }
    case false: {
      switch (submitted.code) {
        case "no_owned_pending_card": {
          if (!input.interactionId || !input.issueId?.trim()) return submitted;
          const handback = await reconcileAnsweredPlanReviewHandback({
            apiBase: input.apiBase,
            issueId: input.issueId,
            agentId: input.agentId,
            interactionId: input.interactionId,
            token: input.token,
            runId: input.runId,
            fetcher: input.fetcher,
          });
          switch (handback.ok) {
            case true:
              return { ok: true, interactionId: handback.interactionId, itemId: "plan", verdict: handback.verdict };
            case false: {
              switch (handback.code) {
                case "invalid_card_evidence":
                  return submitted;
                default:
                  return { ok: false, code: handback.code };
              }
            }
          }
        }
        default:
          return submitted;
      }
    }
  }
}

/** A reviewer may finish its own helper task; the parent never changes owner. */
async function completeOwnChildPlanReview(input: NativeReviewRuntimeSubmissionInput, key: string | undefined, interactionId: string): Promise<void> {
  if (!input.issueId || !input.token || !input.runId || !key) throw new Error("Missing authenticated child completion scope");
  const root = input.apiBase.replace(/\/+$/, "").replace(/\/api$/, "");
  const path = `${root}/api/issues/${encodeURIComponent(input.issueId)}`;
  const headers = { Authorization: `Bearer ${input.token}`, "X-Paperclip-Run-Id": input.runId, "Content-Type": "application/json" };
  const fetcher = input.fetcher ?? nativeReviewFetch;
  const response = await fetcher(path, { headers });
  if (!response.ok) throw new Error("Cannot verify child completion ownership");
  const child = record(await response.json());
  const identity = parseChildPlanReviewDescription(child?.["description"]);
  if (!child || !isStablePlanReviewChild(child) || !identity || childPlanReviewKey(identity) !== key ||
      child["id"] !== input.issueId || child["assigneeAgentId"] !== input.agentId || identity.reviewerAgentId !== input.agentId) {
    throw new Error("Child completion identity mismatch");
  }
  if (child["status"] === "done") return;
  const policy = record(child["executionPolicy"]);
  if (!["todo", "in_progress"].includes(String(child["status"])) || child["executionBlocker"] != null ||
      record(child["executionState"])?.["status"] === "pending" || policy?.["monitor"] ||
      (Array.isArray(policy?.["stages"]) && policy["stages"].length > 0)) throw new Error("Child completion conflicts with another workflow");
  const completed = await fetcher(path, { method: "PATCH", headers, body: JSON.stringify({ status: "done",
    executionPolicy: { ...policy, mode: "normal", stages: [], commentRequired: false },
    comment: `Child review task finished; native card ${interactionId} contains the recorded decision.`,
  }) });
  if (!completed.ok) throw new Error("Child completion PATCH failed");
  const receipt = record(await completed.json());
  if (receipt?.["id"] !== input.issueId || receipt["status"] !== "done" || receipt["assigneeAgentId"] !== input.agentId) {
    throw new Error("Child completion receipt mismatch");
  }
}
