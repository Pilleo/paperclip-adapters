import type { JulesActivity } from "./jules-client.js";
import type { JulesAdapterSessionV1 } from "./session.js";
import { asJulesActivityId } from "./brands.js";
import { beginEffect, confirmEffect } from "./lifecycle-effect-journal.js";
import { findApprovedPlanActivity } from "./provider-plan-approval-evidence.js";

export interface ExternalApprovedPlanReceipt {
  readonly kind: "approve_plan";
  readonly state: "accepted";
  readonly httpStatus: 200 | 204;
  readonly attempts: 1;
  readonly effectId: string;
  readonly issueId: string;
  readonly sessionId: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly planActivityId: string;
  readonly createdAt: string;
  readonly reviewers: readonly {
    readonly cardId: string; readonly reviewerAgentId: string; readonly runId: string;
  }[];
}

/** Adopt one externally accepted approval only after exact provider and board evidence was checked. */
export function adoptExternallyApprovedPlan(session: JulesAdapterSessionV1, input: {
  readonly receipt: ExternalApprovedPlanReceipt;
  readonly providerActivities: readonly JulesActivity[];
  readonly historyComplete: boolean;
  readonly providerPrUrl: string;
  readonly boardDocumentRevisionId: string;
}): JulesAdapterSessionV1 {
  const { receipt } = input;
  const identity = session.childPlanReview?.identity;
  const effectId = `approve:${receipt.sessionId}:${receipt.revisionId}`;
  if (receipt.kind !== "approve_plan" || receipt.state !== "accepted" ||
      ![200, 204].includes(receipt.httpStatus) || receipt.attempts !== 1 ||
      receipt.effectId !== effectId || receipt.issueId !== session.paperclipIssueId ||
      receipt.sessionId !== session.julesSessionId || receipt.revisionId !== input.boardDocumentRevisionId ||
      receipt.reviewers.length !== 2 ||
      new Set(receipt.reviewers.map((reviewer) => reviewer.runId)).size !== 2 ||
      new Set(receipt.reviewers.map((reviewer) => reviewer.reviewerAgentId)).size !== 2 ||
      receipt.reviewers.some((reviewer) => !reviewer.cardId || !reviewer.runId || !reviewer.reviewerAgentId)) {
    throw new Error("External approval receipt does not identify one reviewed plan effect");
  }
  const current = session.lifecycleEffectJournal?.effects.find((effect) => effect.effectId === effectId);
  if (identity) {
    if (identity.stage !== "terra" || identity.sessionId !== receipt.sessionId ||
        identity.parentIssueId !== receipt.issueId || identity.documentId !== receipt.documentId ||
        identity.revisionId !== receipt.revisionId || identity.activityId !== receipt.planActivityId ||
        !receipt.reviewers.some((reviewer) => reviewer.reviewerAgentId === identity.reviewerAgentId)) {
      throw new Error("Jules checkpoint no longer addresses this strong-reviewed plan");
    }
  } else if (current?.attempt.kind !== "confirmed" || session.planApprovedActivityId !== receipt.planActivityId) {
    throw new Error("Jules approval checkpoint has already changed");
  }
  let pr: URL;
  try { pr = new URL(input.providerPrUrl); }
  catch { throw new Error("Provider PR URL is invalid"); }
  const repository = session.repository.toLowerCase();
  if (pr.protocol !== "https:" || pr.hostname !== "github.com" ||
      !new RegExp(`^/${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/[1-9]\\d*/?$`, "i").test(pr.pathname)) {
    throw new Error("Provider PR is not from the reviewed repository");
  }
  const approvedId = findApprovedPlanActivity({ activities: input.providerActivities,
    planActivityId: receipt.planActivityId, startedAt: receipt.createdAt, historyComplete: input.historyComplete });
  const approvedAt = input.providerActivities.find((activity) => activity.id === approvedId)?.createTime;
  if (!approvedId || !approvedAt) throw new Error("Provider did not approve the exact plan after the persisted attempt");
  const receiptValue = `provider:${approvedId}`;
  if (current?.attempt.kind === "confirmed") {
    if (current.attempt.receipt !== receiptValue) throw new Error("Approval effect receipt changed");
    return session;
  }
  const begun = beginEffect(session.lifecycleEffectJournal ?? { version: 1, effects: [] },
    { effectId, kind: "approve_plan", startedAt: receipt.createdAt });
  const journal = confirmEffect(begun, effectId, receiptValue);
  return {
    ...session, childPlanReview: undefined, lifecycleEffectJournal: journal,
    planApprovedAt: approvedAt, planApprovedActivityId: asJulesActivityId(receipt.planActivityId),
    planReviewOutcome: "approved",
  };
}
