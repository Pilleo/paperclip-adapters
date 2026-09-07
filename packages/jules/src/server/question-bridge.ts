/**
 * Typed lifecycle for the adapters-only Jules question bridge.
 *
 * The parent Jules issue and the Terra-owned reviewer child are deliberately
 * separate state machines.  This reducer contains no Paperclip or provider
 * side effects; callers execute only the returned idempotent action.
 */
export type BridgeParentState = "pending" | "answered" | "closed";
export type BridgeChildState = "absent" | "pending" | "answered" | "malformed" | "escalated";
export type BridgeReviewerRunState =
  | "absent" | "queued" | "running" | "succeeded" | "failed"
  | "cancelled_assignee_changed" | "cancelled";
export type BridgeDeliveryState = "not_delivered" | "parent_recorded" | "provider_delivered";

export type QuestionBridgeSnapshot = Readonly<{
  parent: BridgeParentState;
  child: BridgeChildState;
  reviewerRun: BridgeReviewerRunState;
  delivery: BridgeDeliveryState;
  childIssueId?: string;
}>;

export type QuestionBridgeAction =
  | "CREATE_CHILD_BRIDGE"
  | "AWAIT_REVIEWER"
  | "RECREATE_CHILD_FORM"
  | "COPY_ANSWER_TO_PARENT"
  | "COPY_ESCALATION_TO_PARENT"
  | "RELAY_ANSWER_TO_JULES"
  | "OPEN_HUMAN_ESCALATION"
  | "COMPLETE_CHILD"
  | "NO_OP"
  | "TERMINAL_FAILURE";

export function questionBridgeAction(snapshot: QuestionBridgeSnapshot): QuestionBridgeAction {
  switch (snapshot.parent) {
    case "closed":
      return snapshot.child === "absent" || snapshot.child === "pending" ? "NO_OP" : "COMPLETE_CHILD";
    case "answered":
      switch (snapshot.delivery) {
        case "provider_delivered": return "COMPLETE_CHILD";
        case "parent_recorded": return snapshot.child === "escalated" ? "OPEN_HUMAN_ESCALATION" : "RELAY_ANSWER_TO_JULES";
        case "not_delivered": return "NO_OP";
      }
      break;
    case "pending":
      break;
  }

  switch (snapshot.child) {
    case "absent":
      return "CREATE_CHILD_BRIDGE";
    case "pending":
      switch (snapshot.reviewerRun) {
        case "cancelled_assignee_changed": return "RECREATE_CHILD_FORM";
        case "failed": return snapshot.childIssueId ? "TERMINAL_FAILURE" : "CREATE_CHILD_BRIDGE";
        case "absent": case "queued": case "running": case "succeeded": case "cancelled": return "AWAIT_REVIEWER";
      }
      break;
    case "malformed":
      return "TERMINAL_FAILURE";
    case "answered":
      return snapshot.delivery === "not_delivered" ? "COPY_ANSWER_TO_PARENT" : "RELAY_ANSWER_TO_JULES";
    case "escalated":
      return snapshot.delivery === "not_delivered" ? "COPY_ESCALATION_TO_PARENT" : "OPEN_HUMAN_ESCALATION";
  }
}

export function questionBridgeIdempotencyKey(
  parentIssueId: string,
  sessionId: string,
  activityId: string,
  generation = 0,
): string {
  return `jules:question-review-child:${parentIssueId}:${sessionId}:${activityId}:${generation}`;
}
