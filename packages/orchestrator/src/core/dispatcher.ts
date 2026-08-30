import {
  ParsedIssueMetadata,
  ConflictEdge,
  ConflictMatrixResult,
  CandidateSelection,
  MultiLaneOptions,
} from "./types.js";
import { symbolLockKey } from "@pilleo/paperclip-adapter-common";

export function isExclusiveLock(issue: ParsedIssueMetadata): boolean {
  if (issue.isNonInterfering) return false;
  if (issue.exclusive || issue.coreLock) return true;
  return issue.targetFiles.length === 0 && issue.targetModules.length === 0;
}

export function issueConflictReason(a: ParsedIssueMetadata, b: ParsedIssueMetadata): string | null {
  if (a.isNonInterfering || b.isNonInterfering) return null;
  if (isExclusiveLock(a) || isExclusiveLock(b)) {
    return `Exclusive lock (${isExclusiveLock(a) ? a.identifier || a.id : b.identifier || b.id})`;
  }

  const aKeys = new Set(a.targetSymbols.map(symbolLockKey));
  const sharedSymbols = b.targetSymbols.map(symbolLockKey).filter((k) => aKeys.has(k));
  if (sharedSymbols.length > 0) {
    return `Shared method/symbol targets: ${sharedSymbols.join(", ")}`;
  }

  const fineGrained =
    a.targetSymbols.length > 0 &&
    b.targetSymbols.length > 0 &&
    a.hasSideEffects === false &&
    b.hasSideEffects === false;

  const sharedModules = a.targetModules.filter((m) => b.targetModules.includes(m));
  if (sharedModules.length > 0 && !fineGrained) {
    return `Shared modules: ${sharedModules.join(", ")}`;
  }

  const sharedFiles = a.targetFiles.filter((f) => b.targetFiles.includes(f));
  if (sharedFiles.length > 0 && !fineGrained) {
    return `Shared files: ${sharedFiles.join(", ")}`;
  }

  return null;
}

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

      const conflictReason = issueConflictReason(a, b);
      if (conflictReason) {
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

  // Active in-progress files/symbols/modules/remote PR files that cannot be touched
  const activeLockedFiles = new Set<string>(options.extraLockedFiles || []);
  const activeLockedSymbols = new Set<string>();
  const activeLockedModules = new Set<string>();
  let exclusiveInFlight = false;

  for (const issue of allIssues) {
    if (issue.status === "in_progress" || issue.status === "in_review") {
      issue.targetFiles.forEach((f) => activeLockedFiles.add(f));
      issue.targetSymbols.forEach((s) => activeLockedSymbols.add(symbolLockKey(s)));
      issue.targetModules.forEach((m) => activeLockedModules.add(m));
      if (isExclusiveLock(issue)) exclusiveInFlight = true;
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
      if (exclusiveInFlight || isExclusiveLock(candidate)) {
        if (exclusiveInFlight) return false;
        if (
          allIssues.some(
            (i) =>
              (i.status === "in_progress" || i.status === "in_review") &&
              !i.isNonInterfering &&
              i.id !== candidate.id
          )
        ) {
          return false;
        }
      }
      for (const sym of candidate.targetSymbols) {
        if (activeLockedSymbols.has(symbolLockKey(sym))) return false;
      }
      const fineGrained = candidate.targetSymbols.length > 0 && candidate.hasSideEffects === false;
      if (!fineGrained) {
        for (const mod of candidate.targetModules) {
          if (activeLockedModules.has(mod)) return false;
        }
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
        if (issueConflictReason(candidate, sel.issue)) {
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
      candidate.targetSymbols.forEach((s) => activeLockedSymbols.add(symbolLockKey(s)));
      candidate.targetModules.forEach((m) => activeLockedModules.add(m));
      if (isExclusiveLock(candidate)) exclusiveInFlight = true;
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
      candidate.targetSymbols.forEach((s) => activeLockedSymbols.add(symbolLockKey(s)));
      candidate.targetModules.forEach((m) => activeLockedModules.add(m));
      if (isExclusiveLock(candidate)) exclusiveInFlight = true;
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
      candidate.targetSymbols.forEach((s) => activeLockedSymbols.add(symbolLockKey(s)));
      candidate.targetModules.forEach((m) => activeLockedModules.add(m));
      if (isExclusiveLock(candidate)) exclusiveInFlight = true;
    }
  }

  return Object.freeze(selections);
}

export const selectNextTasks = selectNextTasksMultiLane;
