export interface StartGateApproval {
  readonly id?: string | undefined;
  readonly type?: string | undefined;
  readonly status?: string | undefined;
  readonly issueIds?: readonly string[] | undefined;
  readonly payload?: Record<string, unknown> | undefined;
}

function isTaskStartForIssue(approval: StartGateApproval, issueId: string): boolean {
  const issueIds = approval.issueIds || [];
  const payloadIssueId = approval.payload?.["issueId"];
  const matchesIssue = issueIds.includes(issueId) || payloadIssueId === issueId;
  if (!matchesIssue) return false;
  return (
    approval.type === "task_start_approval" ||
    (approval.type === "request_board_approval" && approval.payload?.["action"] === "task_start")
  );
}

/**
 * Independent Jules (and any direct wakeup) must not start work while a
 * task_start card is still pending or rejected. Orchestrator dispatch already
 * waits; this blocks the adapter itself so a wakeup cannot bypass the board.
 */
export function evaluateJulesStartGate(
  approvals: readonly StartGateApproval[],
  issueId: string,
): { readonly allow: boolean; readonly reason: string } {
  const start = approvals.find((approval) => isTaskStartForIssue(approval, issueId));
  if (!start) {
    return { allow: true, reason: "No task_start card on this issue." };
  }
  if (start.status === "approved") {
    return { allow: true, reason: `Operator approved task start (${start.id || "approval"}).` };
  }
  if (start.status === "rejected") {
    return {
      allow: false,
      reason: `Operator rejected task start (${start.id || "approval"}). Jules will not create or resume a session.`,
    };
  }
  return {
    allow: false,
    reason: `Awaiting operator task_start approval (${start.id || "pending"}). Jules will not work this issue until the board card is approved.`,
  };
}
