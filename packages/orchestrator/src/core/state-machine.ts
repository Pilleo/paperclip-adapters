import { IssueStatus } from "./types.js";

export type OrchestratorEvent =
  | { readonly type: "DISPATCH"; readonly targetAgentId: string; readonly reason: string }
  | { readonly type: "SUBMIT_FOR_REVIEW"; readonly reviewerAgentId: string; readonly prUrl?: string | undefined }
  | { readonly type: "APPROVE_AND_MERGE"; readonly prNumber?: number | undefined; readonly reason?: string | undefined }
  | { readonly type: "REQUEST_CHANGES"; readonly feedback?: string | undefined }
  | { readonly type: "CANCEL"; readonly reason?: string | undefined }
  | { readonly type: "BLOCK"; readonly blockerIds: readonly string[] }
  | { readonly type: "UNBLOCK" };

export interface StateTransitionResult {
  readonly fromStatus: IssueStatus | string;
  readonly toStatus: IssueStatus;
  readonly isAllowed: boolean;
  readonly updatedAssigneeAgentId?: string | null | undefined;
  readonly reason: string;
}

export function evaluateIssueTransition(
  currentStatus: IssueStatus | string,
  currentAssigneeId: string | null | undefined,
  event: OrchestratorEvent
): StateTransitionResult {
  const normStatus = (currentStatus || "").toLowerCase() as IssueStatus;

  switch (event.type) {
    case "DISPATCH": {
      if (normStatus === "backlog" || normStatus === "todo" || normStatus === "blocked") {
        return {
          fromStatus: normStatus,
          toStatus: "in_progress",
          isAllowed: true,
          updatedAssigneeAgentId: event.targetAgentId,
          reason: event.reason,
        };
      }
      return {
        fromStatus: normStatus,
        toStatus: normStatus,
        isAllowed: false,
        updatedAssigneeAgentId: currentAssigneeId,
        reason: `Cannot dispatch issue in terminal or active status: ${normStatus}`,
      };
    }

    case "SUBMIT_FOR_REVIEW": {
      if (normStatus === "in_progress" || normStatus === "todo") {
        return {
          fromStatus: normStatus,
          toStatus: "in_review",
          isAllowed: true,
          updatedAssigneeAgentId: event.reviewerAgentId,
          reason: event.prUrl ? `Submitted for review with PR ${event.prUrl}` : "Submitted for code review",
        };
      }
      return {
        fromStatus: normStatus,
        toStatus: normStatus,
        isAllowed: false,
        updatedAssigneeAgentId: currentAssigneeId,
        reason: `Cannot submit for review from status: ${normStatus}`,
      };
    }

    case "APPROVE_AND_MERGE": {
      if (normStatus !== "done" && normStatus !== "cancelled") {
        return {
          fromStatus: normStatus,
          toStatus: "done",
          isAllowed: true,
          updatedAssigneeAgentId: currentAssigneeId,
          reason: event.prNumber ? `PR #${event.prNumber} merged on GitHub` : event.reason || "Approved and completed",
        };
      }
      return {
        fromStatus: normStatus,
        toStatus: "done",
        isAllowed: false,
        updatedAssigneeAgentId: currentAssigneeId,
        reason: `Issue is already ${normStatus}`,
      };
    }

    case "REQUEST_CHANGES": {
      if (normStatus === "in_review") {
        return {
          fromStatus: normStatus,
          toStatus: "todo",
          isAllowed: true,
          updatedAssigneeAgentId: null,
          reason: event.feedback || "Reviewer requested changes",
        };
      }
      return {
        fromStatus: normStatus,
        toStatus: normStatus,
        isAllowed: false,
        updatedAssigneeAgentId: currentAssigneeId,
        reason: `Cannot request changes when not in review (current: ${normStatus})`,
      };
    }

    case "CANCEL": {
      if (normStatus !== "done") {
        return {
          fromStatus: normStatus,
          toStatus: "cancelled",
          isAllowed: true,
          updatedAssigneeAgentId: null,
          reason: event.reason || "Task cancelled",
        };
      }
      return {
        fromStatus: normStatus,
        toStatus: normStatus,
        isAllowed: false,
        updatedAssigneeAgentId: currentAssigneeId,
        reason: "Cannot cancel an already completed task",
      };
    }

    case "BLOCK": {
      if (normStatus === "backlog" || normStatus === "todo") {
        return {
          fromStatus: normStatus,
          toStatus: "blocked",
          isAllowed: true,
          updatedAssigneeAgentId: currentAssigneeId,
          reason: `Blocked by ${event.blockerIds.join(", ")}`,
        };
      }
      return {
        fromStatus: normStatus,
        toStatus: normStatus,
        isAllowed: false,
        updatedAssigneeAgentId: currentAssigneeId,
        reason: `Cannot block task in status: ${normStatus}`,
      };
    }

    case "UNBLOCK": {
      if (normStatus === "blocked") {
        return {
          fromStatus: normStatus,
          toStatus: "backlog",
          isAllowed: true,
          updatedAssigneeAgentId: currentAssigneeId,
          reason: "Blockers resolved; moved to backlog",
        };
      }
      return {
        fromStatus: normStatus,
        toStatus: normStatus,
        isAllowed: false,
        updatedAssigneeAgentId: currentAssigneeId,
        reason: `Task is not currently blocked (status: ${normStatus})`,
      };
    }
  }
}
