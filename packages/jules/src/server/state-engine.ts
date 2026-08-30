import { JulesAdapterSessionV1 } from "./session.js";
import { IssueStatus, IssueDisposition } from "./disposition.js";
import { evaluateSessionWatchdog } from "./watchdog.js";

export type JulesTaskPhase =
  | "INITIALIZING"
  | "PLANNING"
  | "AWAITING_PLAN_APPROVAL"
  | "CODING"
  | "PR_CREATED_AWAITING_CI"
  | "IN_REVIEW"
  | "APPLYING_REVIEW_CHANGES"
  | "COMPLETED_AND_MERGED"
  | "BLOCKED"
  | "FAILED";

export interface JulesLifecycleSignals {
  readonly julesState: string;
  readonly prUrl?: string | undefined;
  readonly prDetails?: { readonly isMerged: boolean; readonly mergeableStatus?: string } | undefined;
  readonly ciStatus?: "success" | "pending" | "failed" | "unknown" | null | undefined;
  readonly unreadReviewComments?: readonly { readonly id: string; readonly body: string }[] | undefined;
  readonly existingInteractions?: readonly { readonly id: string; readonly kind?: string; readonly status: string }[] | undefined;
  readonly lastActivityTime?: string | undefined;
  readonly nowMs?: number | undefined;
  readonly planMarkdown?: string | undefined;
  readonly userQuestion?: string | undefined;
  readonly scopeConformant?: boolean | undefined;
  readonly scopeSummary?: string | undefined;
}

export type LifecycleAction =
  | { readonly type: "RELAY_REVIEW_FEEDBACK"; readonly prompt: string; readonly commentId: string }
  | { readonly type: "AUTO_APPROVE_PLAN"; readonly planMarkdown: string }
  | { readonly type: "CREATE_PLAN_CARD"; readonly planMarkdown: string }
  | { readonly type: "CREATE_FEEDBACK_CARD"; readonly question: string }
  | { readonly type: "CREATE_REVIEW_CARD"; readonly prUrl: string }
  | { readonly type: "NUDGE_WATCHDOG"; readonly message: string }
  | { readonly type: "RESET_PAUSED_SESSION" }
  | { readonly type: "FLAG_SCOPE_DRIFT"; readonly summary: string };

export interface JulesLifecyclePlan {
  readonly phase: JulesTaskPhase;
  readonly issueTransition: {
    readonly targetStatus: IssueStatus;
    readonly disposition?: IssueDisposition | undefined;
    readonly comment?: string | undefined;
  } | null;
  readonly actions: readonly LifecycleAction[];
  readonly shouldDeleteSession: boolean;
  readonly shouldExitRun: boolean;
  readonly exitCode: number;
}

/**
 * Pure state machine evaluator for Jules cloud sessions.
 * Translates external state signals into a deterministic TransitionPlan.
 */
export function evaluateJulesLifecycleState(
  session: JulesAdapterSessionV1,
  signals: JulesLifecycleSignals
): JulesLifecyclePlan {
  const nowMs = signals.nowMs ?? Date.now();
  const actions: LifecycleAction[] = [];

  // 1. PR Merged -> Terminal success
  if (signals.prDetails?.isMerged) {
    return {
      phase: "COMPLETED_AND_MERGED",
      issueTransition: {
        targetStatus: "done",
        disposition: signals.prUrl
          ? { targetStatus: "done", kind: "pr_merged", prUrl: signals.prUrl }
          : undefined,
        comment: `Jules PR ${signals.prUrl || ""} was merged on GitHub. Task completed.`,
      },
      actions: [],
      shouldDeleteSession: true,
      shouldExitRun: true,
      exitCode: 0,
    };
  }

  // 2. PR Conflict -> stay on the existing session; host rebases locally (no new Jules session)
  if (signals.prDetails?.mergeableStatus === "conflicting") {
    return {
      phase: "PR_CREATED_AWAITING_CI",
      issueTransition: {
        targetStatus: "in_review",
        comment: `Pull request ${signals.prUrl || ""} has merge conflicts. Resolve them locally (rebase on the host). Do not start a new Jules session.`,
      },
      actions: [],
      shouldDeleteSession: false,
      shouldExitRun: true,
      exitCode: 0,
    };
  }

  // 3. Unread Review Comments -> Relay changes to Jules
  if (signals.unreadReviewComments && signals.unreadReviewComments.length > 0) {
    for (const comment of signals.unreadReviewComments) {
      actions.push({
        type: "RELAY_REVIEW_FEEDBACK",
        commentId: comment.id,
        prompt: `Code Review Feedback received:\n\n${comment.body}`,
      });
    }

    return {
      phase: "APPLYING_REVIEW_CHANGES",
      issueTransition: {
        targetStatus: "in_progress",
        disposition: {
          targetStatus: "in_progress",
          kind: "assigned_worker",
          workerAgentId: session.sessionId || "",
        },
        comment: "Code review feedback received; applying changes on PR branch.",
      },
      actions,
      shouldDeleteSession: false,
      shouldExitRun: false,
      exitCode: 0,
    };
  }

  // 4. PR exists but drifted from the host plan contract
  if (signals.prUrl && signals.scopeConformant === false) {
    return {
      phase: "CODING",
      issueTransition: {
        targetStatus: "in_progress",
        comment: signals.scopeSummary,
      },
      actions: [{ type: "FLAG_SCOPE_DRIFT", summary: signals.scopeSummary || "Scope drift vs declared plan." }],
      shouldDeleteSession: false,
      shouldExitRun: true,
      exitCode: 0,
    };
  }

  // 5. PR Open with Green CI -> In Review
  if (signals.prUrl && signals.ciStatus === "success") {
    const existingReviewCard = signals.existingInteractions?.find(
      (i) => i.kind === "request_confirmation" && i.status === "pending"
    );

    return {
      phase: "IN_REVIEW",
      issueTransition: {
        targetStatus: "in_review",
        disposition: existingReviewCard
          ? {
              targetStatus: "in_review",
              kind: "interaction_card",
              interactionId: existingReviewCard.id,
            }
          : undefined,
        comment: `Jules completed this task and created PR: ${signals.prUrl}`,
      },
      actions,
      shouldDeleteSession: false, // KEEP SESSION ALIVE FOR REVIEW LOOP!
      shouldExitRun: false,
      exitCode: 0,
    };
  }

  // 5. Watchdog Evaluation for Idle In-Progress Sessions
  if (
    signals.julesState === "IN_PROGRESS" ||
    signals.julesState === "PLANNING" ||
    session.phase === "RUNNING"
  ) {
    const watchdog = evaluateSessionWatchdog(session, signals.lastActivityTime, nowMs);
    if (watchdog.shouldNudge && watchdog.nudgeMessage) {
      actions.push({
        type: "NUDGE_WATCHDOG",
        message: watchdog.nudgeMessage,
      });
    }
  }

  return {
    phase: "CODING",
    issueTransition: null,
    actions,
    shouldDeleteSession: false,
    shouldExitRun: false,
    exitCode: 0,
  };
}
