import {
  ParsedIssueMetadata,
  ConflictEdge,
  ConflictMatrixResult,
  CandidateSelection,
  MultiLaneOptions,
} from "./types.js";
import { parseSymbolTarget } from "@pilleo/paperclip-adapter-common";

/**
 * Pure functions for dependency DAG calculation, conflict edge evaluation,
 * and deterministic multi-lane candidate scheduling with method-level granularity.
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
      
      // Method/Symbol-level granularity matching
      const aSymbols = a.targetSymbols.map(parseSymbolTarget);
      const bSymbols = b.targetSymbols.map(parseSymbolTarget);
      const sharedSymbols = a.targetSymbols.filter((s) => b.targetSymbols.includes(s));

      let hasConflict = false;
      let conflictReason = "";

      if (sharedSymbols.length > 0) {
        hasConflict = true;
        conflictReason = `Shared method/symbol targets: ${sharedSymbols.join(", ")}`;
      } else if (sharedFiles.length > 0) {
        // If both tasks define explicit, disjoint method targets within the shared file,
        // they can proceed without a hard conflict if both declare fine-grained symbols.
        const bothHaveMethodTargets = a.targetSymbols.length > 0 && b.targetSymbols.length > 0;
        if (!bothHaveMethodTargets) {
          hasConflict = true;
          conflictReason = `Shared files: ${sharedFiles.join(", ")}`;
        }
      }

      if (hasConflict) {
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

  let julesAvailable = Math.max(0, julesCapacity - julesRunning);
  let vibeAvailable = Math.max(0, vibeCapacity - vibeRunning);

  const maxToSelect = options.maxToSelect ?? (julesAvailable + vibeAvailable);

  const blockedMap = conflictResult.blockedByMap;

  // Active in-progress files/symbols/remote PR files that cannot be touched
  const activeLockedFiles = new Set<string>(options.extraLockedFiles || []);
  const activeLockedSymbols = new Set<string>();

  for (const issue of allIssues) {
    if (issue.status === "in_progress" || issue.status === "in_review") {
      issue.targetFiles.forEach((f) => activeLockedFiles.add(f));
      issue.targetSymbols.forEach((s) => activeLockedSymbols.add(s));
    }
  }

  const unblockedCandidates = allIssues.filter((candidate) => {
    if (candidate.status !== "todo" && candidate.status !== "backlog") {
      return false;
    }

    if (candidate.openQuestions) {
      return false;
    }

    const blockers = blockedMap.get(candidate.id) || [];
    for (const blockerId of blockers) {
      const blocker = allIssues.find((i) => i.id === blockerId);
      if (blocker && blocker.status !== "done" && blocker.status !== "cancelled") {
        return false;
      }
    }

    if (!candidate.isNonInterfering) {
      // Check method/symbol locks first
      for (const sym of candidate.targetSymbols) {
        if (activeLockedSymbols.has(sym)) return false;
      }
      // Check file locks if not fine-grained method targets
      if (candidate.targetSymbols.length === 0) {
        for (const file of candidate.targetFiles) {
          if (activeLockedFiles.has(file)) return false;
        }
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
        const sharedSymbols = candidate.targetSymbols.filter((s) => sel.issue.targetSymbols.includes(s));
        if (sharedSymbols.length > 0) {
          collidesWithSelected = true;
          break;
        }
        if (candidate.targetSymbols.length === 0 || sel.issue.targetSymbols.length === 0) {
          const sharedFiles = candidate.targetFiles.filter((f) => sel.issue.targetFiles.includes(f));
          if (sharedFiles.length > 0) {
            collidesWithSelected = true;
            break;
          }
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
          reason: "Routed to secondary Vibe lane (Jules full)",
        })
      );
      vibeAvailable--;
      candidate.targetFiles.forEach((f) => activeLockedFiles.add(f));
      candidate.targetSymbols.forEach((s) => activeLockedSymbols.add(s));
    }
  }

  return Object.freeze(selections);
}

export const selectNextTasks = selectNextTasksMultiLane;
