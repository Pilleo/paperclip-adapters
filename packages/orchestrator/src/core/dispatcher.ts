import {
  ParsedIssueMetadata,
  ConflictEdge,
  ConflictMatrixResult,
  CandidateSelection,
  MultiLaneOptions,
} from "./types.js";

/**
 * Pure functions for dependency DAG calculation, conflict edge evaluation,
 * and deterministic multi-lane candidate scheduling.
 */

export function calculateConflictMatrix(issues: readonly ParsedIssueMetadata[]): ConflictMatrixResult {
  const blockedByMap = new Map<string, string[]>();
  const conflictEdges: ConflictEdge[] = [];

  for (const issue of issues) {
    if (!blockedByMap.has(issue.id)) {
      blockedByMap.set(issue.id, []);
    }
  }

  // 1. Direct explicit dependencies
  const identifierToId = new Map<string, string>();
  for (const issue of issues) {
    if (issue.identifier) {
      identifierToId.set(issue.identifier.toUpperCase(), issue.id);
      const match = issue.identifier.match(/\d+/);
      const numMatch = match?.[0];
      if (numMatch) identifierToId.set(numMatch, issue.id);
    }
    if (issue.issueNumber) {
      identifierToId.set(String(issue.issueNumber), issue.id);
    }
    identifierToId.set(issue.id, issue.id);
  }

  for (const issue of issues) {
    const directBlockers = blockedByMap.get(issue.id);
    if (!directBlockers) continue;

    for (const dep of issue.dependencies) {
      const depKey = dep.trim().toUpperCase();
      const depNumMatch = depKey.match(/\d+/)?.[0];
      const blockerId = identifierToId.get(depKey) || (depNumMatch ? identifierToId.get(depNumMatch) : undefined);
      if (blockerId && blockerId !== issue.id && !directBlockers.includes(blockerId)) {
        directBlockers.push(blockerId);
        conflictEdges.push({
          issueId1: blockerId,
          issueId2: issue.id,
          reason: `Explicit dependency: ${dep}`,
        });
      }
    }
  }

  // 2. Resource conflict matrix (overlapping targetFiles or targetSymbols)
  const activeIssues = issues.filter(
    (i) => i.status === "in_progress" || i.status === "todo" || i.status === "backlog" || i.status === "in_review"
  );

  for (let i = 0; i < activeIssues.length; i++) {
    const a = activeIssues[i];
    if (!a) continue;

    for (let j = i + 1; j < activeIssues.length; j++) {
      const b = activeIssues[j];
      if (!b) continue;

      if (a.isNonInterfering || b.isNonInterfering) continue;

      const sharedFiles = a.targetFiles.filter((f) => b.targetFiles.includes(f));
      const sharedSymbols = a.targetSymbols.filter((s) => b.targetSymbols.includes(s));

      if (sharedFiles.length > 0 || sharedSymbols.length > 0) {
        const conflictReason =
          sharedFiles.length > 0
            ? `Shared files: ${sharedFiles.join(", ")}`
            : `Shared symbols: ${sharedSymbols.join(", ")}`;

        let blocker: ParsedIssueMetadata;
        let blocked: ParsedIssueMetadata;

        // In-progress tasks always take precedence over pending tasks
        if (a.status === "in_progress" && b.status !== "in_progress") {
          blocker = a;
          blocked = b;
        } else if (b.status === "in_progress" && a.status !== "in_progress") {
          blocker = b;
          blocked = a;
        } else if (a.priorityRank > b.priorityRank) {
          blocker = a;
          blocked = b;
        } else if (b.priorityRank > a.priorityRank) {
          blocker = b;
          blocked = a;
        } else {
          const aKey = a.identifier || a.id;
          const bKey = b.identifier || b.id;
          if (aKey.localeCompare(bKey) <= 0) {
            blocker = a;
            blocked = b;
          } else {
            blocker = b;
            blocked = a;
          }
        }

        const currentBlockers = blockedByMap.get(blocked.id) || [];
        if (!currentBlockers.includes(blocker.id)) {
          currentBlockers.push(blocker.id);
          blockedByMap.set(blocked.id, currentBlockers);
          conflictEdges.push({
            issueId1: blocker.id,
            issueId2: blocked.id,
            reason: conflictReason,
          });
        }
      }
    }
  }

  const frozenBlockedByMap = new Map<string, readonly string[]>();
  for (const [key, value] of blockedByMap.entries()) {
    frozenBlockedByMap.set(key, Object.freeze([...value]));
  }

  return {
    blockedByMap: frozenBlockedByMap,
    conflictEdges: Object.freeze(conflictEdges),
  };
}

export function selectNextTasksMultiLane(
  allIssues: readonly ParsedIssueMetadata[],
  conflictResult: ConflictMatrixResult,
  options: MultiLaneOptions = {}
): readonly CandidateSelection[] {
  const julesCapacity = options.julesCapacity ?? 15;
  const vibeCapacity = options.vibeCapacity ?? 1;
  const julesRunning = options.julesRunningCount ?? 0;
  const vibeRunning = options.vibeRunningCount ?? 0;
  const maxToSelect = options.maxToSelect ?? 15;

  let julesAvailable = Math.max(0, julesCapacity - julesRunning);
  let vibeAvailable = Math.max(0, vibeCapacity - vibeRunning);

  if (julesAvailable <= 0 && vibeAvailable <= 0) {
    return Object.freeze([]);
  }

  const issueById = new Map<string, ParsedIssueMetadata>(allIssues.map((i) => [i.id, i]));
  const inProgressIssues = allIssues.filter((i) => i.status === "in_progress");

  // Candidate pool: unassigned backlog / todo tasks
  const candidatePool = allIssues.filter(
    (i) => (i.status === "backlog" || i.status === "todo") && !i.assigneeAgentId
  );

  const activeLockedFiles = new Set<string>(options.extraLockedFiles || []);
  const activeLockedSymbols = new Set<string>();
  for (const running of inProgressIssues) {
    if (running.isNonInterfering) continue;
    running.targetFiles.forEach((f) => activeLockedFiles.add(f));
    running.targetSymbols.forEach((s) => activeLockedSymbols.add(s));
  }

  // Filter candidates whose DAG blockers are not yet terminal (done or cancelled)
  const unblockedCandidates = candidatePool.filter((candidate) => {
    const blockers = conflictResult.blockedByMap.get(candidate.id) || [];
    for (const blockerId of blockers) {
      const blocker = issueById.get(blockerId);
      if (blocker && blocker.status !== "done" && blocker.status !== "cancelled") {
        return false;
      }
    }

    if (!candidate.isNonInterfering) {
      for (const file of candidate.targetFiles) {
        if (activeLockedFiles.has(file)) return false;
      }
      for (const sym of candidate.targetSymbols) {
        if (activeLockedSymbols.has(sym)) return false;
      }
    }

    return true;
  });

  const sortedCandidates = [...unblockedCandidates].sort((a, b) => {
    if (b.priorityRank !== a.priorityRank) {
      return b.priorityRank - a.priorityRank;
    }
    const aKey = a.identifier || a.id;
    const bKey = b.identifier || b.id;
    return aKey.localeCompare(bKey);
  });

  const selections: CandidateSelection[] = [];

  for (const candidate of sortedCandidates) {
    if (selections.length >= maxToSelect) break;

    let collidesWithSelected = false;
    if (!candidate.isNonInterfering) {
      for (const sel of selections) {
        const sharedFiles = candidate.targetFiles.filter((f) => sel.issue.targetFiles.includes(f));
        const sharedSymbols = candidate.targetSymbols.filter((s) => sel.issue.targetSymbols.includes(s));
        if (sharedFiles.length > 0 || sharedSymbols.length > 0) {
          collidesWithSelected = true;
          break;
        }
      }
    }
    if (collidesWithSelected) continue;

    const rawDesc = typeof candidate.rawIssue["description"] === "string" ? (candidate.rawIssue["description"] as string) : "";
    const prefersVibe =
      candidate.component === "enforcer" ||
      rawDesc.includes("executor: vibe") ||
      rawDesc.includes('executor: "vibe"');

    if (prefersVibe && vibeAvailable > 0 && options.vibeAgentId) {
      selections.push(
        Object.freeze({
          issue: candidate,
          targetAgentId: options.vibeAgentId,
          reason: `Routed to Vibe lane (${candidate.component || "explicit"})`,
        })
      );
      vibeAvailable--;
      candidate.targetFiles.forEach((f) => activeLockedFiles.add(f));
      candidate.targetSymbols.forEach((s) => activeLockedSymbols.add(s));
    } else if (julesAvailable > 0) {
      selections.push(
        Object.freeze({
          issue: candidate,
          targetAgentId: options.julesAgentId,
          reason: "Routed to primary Jules lane",
        })
      );
      julesAvailable--;
      candidate.targetFiles.forEach((f) => activeLockedFiles.add(f));
      candidate.targetSymbols.forEach((s) => activeLockedSymbols.add(s));
    } else if (vibeAvailable > 0) {
      selections.push(
        Object.freeze({
          issue: candidate,
          targetAgentId: options.vibeAgentId,
          reason: "Routed to Vibe fallback lane",
        })
      );
      vibeAvailable--;
      candidate.targetFiles.forEach((f) => activeLockedFiles.add(f));
      candidate.targetSymbols.forEach((s) => activeLockedSymbols.add(s));
    }
  }

  return Object.freeze(selections);
}

export function selectNextTasks(
  allIssues: readonly ParsedIssueMetadata[],
  conflictResult: ConflictMatrixResult,
  options: {
    readonly maxToSelect?: number | undefined;
    readonly preferredWorkerAgentId?: string | undefined;
    readonly allowedWorkerAgentIds?: readonly string[] | undefined;
    readonly runningCount?: number | undefined;
    readonly maxConcurrent?: number | undefined;
  } = {}
): readonly CandidateSelection[] {
  return selectNextTasksMultiLane(allIssues, conflictResult, {
    julesAgentId: options.preferredWorkerAgentId,
    julesCapacity: options.maxConcurrent ?? 1,
    julesRunningCount: options.runningCount ?? 0,
    maxToSelect: options.maxToSelect ?? 1,
  });
}
