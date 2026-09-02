export type BarrierStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled" | string;

export interface BarrierIssue {
  readonly id: string;
  readonly status: BarrierStatus;
}

export interface BarrierRun {
  readonly id: string;
  readonly issueId: string | null;
  readonly status: string;
}

export interface TerminalParentBarrierPlan {
  readonly cancelRunIds: readonly string[];
  readonly closeIssueIds: readonly string[];
  readonly reason: string | null;
}

const TERMINAL = new Set(["done", "cancelled"]);
const ACTIVE_RUNS = new Set(["queued", "running", "claimed"]);

/**
 * Pure terminal-subtree barrier. A child must lose its queued/running work
 * before its issue is closed; otherwise a stale heartbeat can reopen it after
 * the parent has already converged. The executor applies this plan in order.
 */
export function planTerminalParentBarrier(input: {
  readonly parent: BarrierIssue;
  readonly descendants: readonly BarrierIssue[];
  readonly runs: readonly BarrierRun[];
}): TerminalParentBarrierPlan {
  if (!TERMINAL.has(input.parent.status)) {
    return { cancelRunIds: [], closeIssueIds: [], reason: null };
  }

  const openChildren = new Set(
    input.descendants
      .filter((child) => !TERMINAL.has(child.status))
      .map((child) => child.id),
  );
  const cancelRunIds = new Set<string>();
  for (const run of input.runs) {
    if (run.issueId && openChildren.has(run.issueId) && ACTIVE_RUNS.has(run.status.toLowerCase())) {
      cancelRunIds.add(run.id);
    }
  }
  return {
    cancelRunIds: [...cancelRunIds].sort(),
    closeIssueIds: [...openChildren].sort(),
    reason: `${input.parent.id} is terminal`,
  };
}

