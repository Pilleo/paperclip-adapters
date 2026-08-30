import { z } from "zod";

/**
 * Invariant-enforcing disposition types for Paperclip issue status transitions.
 * Prevents invalid or orphaned transitions (such as moving to `in_review` without a review path)
 * from being constructed.
 */

export type InReviewDisposition =
  | { readonly kind: "interaction_card"; readonly interactionId: string }
  | { readonly kind: "assigned_reviewer"; readonly reviewerAgentId: string }
  | { readonly kind: "assigned_user"; readonly userId: string };

export type InProgressDisposition = {
  readonly kind: "assigned_worker";
  readonly workerAgentId: string;
};

export type BlockedDisposition =
  | { readonly kind: "unresolved_blockers"; readonly blockerIds: readonly string[] }
  | { readonly kind: "pending_interaction"; readonly interactionId: string }
  | { readonly kind: "manual_intervention_required"; readonly reason: string };

export type DoneDisposition =
  | { readonly kind: "pr_merged"; readonly prUrl: string }
  | { readonly kind: "operator_confirmed"; readonly interactionId: string };

export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";

export type IssueDisposition =
  | ({ readonly targetStatus: "in_review" } & InReviewDisposition)
  | ({ readonly targetStatus: "in_progress" } & InProgressDisposition)
  | ({ readonly targetStatus: "blocked" } & BlockedDisposition)
  | ({ readonly targetStatus: "done" } & DoneDisposition)
  | { readonly targetStatus: "todo" }
  | { readonly targetStatus: "backlog" }
  | { readonly targetStatus: "cancelled"; readonly reason?: string };

export interface IssueTransitionValidation {
  readonly isValid: boolean;
  readonly error?: string | undefined;
  readonly payloadPatch: Record<string, unknown>;
}

/**
 * Pure function that validates whether an issue status mutation satisfies
 * Paperclip server disposition invariants, and builds the exact PATCH payload.
 */
export function buildValidatedIssuePatch(
  targetStatus: IssueStatus,
  disposition?: IssueDisposition,
  comment?: string
): IssueTransitionValidation {
  const basePatch: Record<string, unknown> = { status: targetStatus };
  if (comment) basePatch["comment"] = comment;

  if (targetStatus === "in_review") {
    if (!disposition || disposition.targetStatus !== "in_review") {
      return {
        isValid: false,
        error: "Moving to in_review requires an InReviewDisposition (linked interaction card or assigned reviewer)",
        payloadPatch: {},
      };
    }

    if (disposition.kind === "interaction_card") {
      basePatch["reviewInteractionId"] = disposition.interactionId;
    } else if (disposition.kind === "assigned_reviewer") {
      basePatch["assigneeAgentId"] = disposition.reviewerAgentId;
    } else if (disposition.kind === "assigned_user") {
      basePatch["assigneeUserId"] = disposition.userId;
    }

    return { isValid: true, payloadPatch: basePatch };
  }

  if (targetStatus === "in_progress") {
    if (disposition && disposition.targetStatus === "in_progress") {
      basePatch["assigneeAgentId"] = disposition.workerAgentId;
    }
    return { isValid: true, payloadPatch: basePatch };
  }

  if (targetStatus === "blocked") {
    return { isValid: true, payloadPatch: basePatch };
  }

  if (targetStatus === "done") {
    return { isValid: true, payloadPatch: basePatch };
  }

  return { isValid: true, payloadPatch: basePatch };
}
