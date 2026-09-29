export type BoardIssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
export type BoardAssigneeKind = "orchestrator" | "jules" | "vibe_reviewer" | "other";

export interface BoardIssueSnapshot {
  readonly id: string;
  readonly identifier: string;
  readonly status: BoardIssueStatus;
  readonly title: string;
  readonly managed: boolean;
  readonly assigneeKind: BoardAssigneeKind;
  readonly executionRunLive: boolean;
  readonly resumableMonitor: boolean;
  /** True when the monitor's due time has elapsed and it is no longer executable. */
  readonly monitorExpired?: boolean;
  readonly nativeReviewInteraction: boolean;
  /** A registered, open PR exists for this managed issue. */
  readonly registeredOpenPullRequest: boolean;
  /**
   * The current heartbeat has already routed failed CI for this immutable PR
   * back to its provider. This is an intra-tick ownership fence, not durable
   * board state: red CI is implementation work and cannot be promoted to
   * native review by a later reconciliation pass.
   */
  readonly ciRemediationInProgress: boolean;
  /** A typed Paperclip recovery action owns the lifecycle until reconciled. */
  readonly executionReconciliationRequired: boolean;
  readonly hasPullRequest: boolean;
  readonly parentId: string | null;
  readonly reviewGateKey: string | null;
}

export type BoardReconciliationCommand =
  | { readonly action: "resume_provider"; readonly issueId: string; readonly reason: string }
  | { readonly action: "cancel_duplicate_child"; readonly issueId: string; readonly reason: string }
  | { readonly action: "recover_to_review"; readonly issueId: string; readonly reason: string }
  | { readonly action: "return_to_todo"; readonly issueId: string; readonly reason: string };

/** Pure, deterministic planner. It produces no Paperclip writes and ignores unowned work. */
export function planBoardReconciliation(issues: readonly BoardIssueSnapshot[]): BoardReconciliationCommand[] {
  const commands: BoardReconciliationCommand[] = [];
  for (const issue of issues) {
    if (!issue.managed) continue;
    // A same-tick failed-CI handoff is stronger than every generic lifecycle
    // repair below. The next heartbeat re-evaluates the provider's new PR
    // head; until then no board transition may replace Jules ownership.
    if (issue.ciRemediationInProgress) continue;
    if (issue.executionReconciliationRequired) continue;
    if (issue.status === "in_progress" && issue.registeredOpenPullRequest &&
        !issue.resumableMonitor && !issue.executionRunLive) {
      commands.push({
        action: "recover_to_review",
        issueId: issue.id,
        reason: "managed issue has a registered open pull request and must enter native review",
      });
      continue;
    }
    if (issue.status === "blocked" && issue.resumableMonitor) {
      commands.push({ action: "resume_provider", issueId: issue.id, reason: "managed task has a resumable provider monitor but no live execution" });
    }
    if (issue.status === "in_progress" && !issue.executionRunLive && (!issue.resumableMonitor || issue.monitorExpired === true)) {
      commands.push({ action: "return_to_todo", issueId: issue.id, reason: "managed task is in progress without a live execution or resumable provider monitor" });
    }
    if (issue.status === "in_review" && !issue.hasPullRequest && !issue.registeredOpenPullRequest &&
        !issue.nativeReviewInteraction && !issue.resumableMonitor) {
      commands.push({ action: "return_to_todo", issueId: issue.id, reason: "review state has neither a pull request nor a native review interaction" });
    }
  }
  // Deduplication is parent-scoped, not gate-scoped. A restarted provider can
  // assign every historical child a different revision, which would make a
  // gate-scoped map contain only singletons and would defeat stale-child
  // cleanup entirely. The gate is used only to select the one current child.
  const byParent = new Map<string, BoardIssueSnapshot[]>();
  for (const issue of issues) {
    if (issue.managed && issue.parentId && issue.reviewGateKey && !["done", "cancelled"].includes(issue.status)) {
      const group = byParent.get(issue.parentId) ?? [];
      group.push(issue);
      byParent.set(issue.parentId, group);
    }
  }
  for (const group of byParent.values()) {
    const parentId = group[0]?.parentId;
    const parent = parentId ? issues.find((issue) => issue.id === parentId) : undefined;
    const currentGate = parent?.reviewGateKey;
    const ordered = [...group].sort((a, b) => a.id.localeCompare(b.id));
    const retained = currentGate
      ? ordered.find((child) => child.reviewGateKey === currentGate)
      : undefined;
    const duplicates = retained
      ? ordered.filter((child) => child.id !== retained.id)
      : (parent?.resumableMonitor ? ordered : ordered.slice(1));
    for (const duplicate of duplicates) {
      commands.push({ action: "cancel_duplicate_child", issueId: duplicate.id, reason: `duplicate delegated review gate ${duplicate.reviewGateKey}` });
    }
  }
  return commands;
}
