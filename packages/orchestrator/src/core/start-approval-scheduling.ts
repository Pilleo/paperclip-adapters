import { isDelegatedReviewChild } from "./recovery-eligibility.js";
import type { ParsedIssueMetadata } from "./types.js";

/**
 * Select the task cards that need a durable start authorization.
 *
 * Authorization is deliberately independent from dispatch readiness: a human
 * may approve a dependent card before its blocker finishes, while the normal
 * dependency gate remains the sole authority that can start execution.
 */
export function selectStartApprovalCandidates(
  issues: readonly ParsedIssueMetadata[],
  rootIssueIds?: readonly string[],
  alreadyAuthorizedRootIssueIds: readonly string[] = [],
): readonly ParsedIssueMetadata[] {
  const eligibleIssues = issues.filter(isEligibleForStartApproval);
  const selectedIssueIds = rootIssueIds === undefined
    ? undefined
    : collectApprovalWaveIssueIds(eligibleIssues, [...rootIssueIds, ...alreadyAuthorizedRootIssueIds]);

  return eligibleIssues
    .filter((issue) => selectedIssueIds === undefined || selectedIssueIds.has(issue.id))
    .slice()
    .sort(compareStartApprovalCandidates);
}

function collectApprovalWaveIssueIds(
  issues: readonly ParsedIssueMetadata[],
  rootIssueIds: readonly string[],
): ReadonlySet<string> {
  const idsByDependencyReference = new Map<string, string>();
  for (const issue of issues) {
    idsByDependencyReference.set(issue.id.toUpperCase(), issue.id);
    if (issue.identifier) idsByDependencyReference.set(issue.identifier.toUpperCase(), issue.id);
  }

  const selectedIds = new Set(rootIssueIds);
  // File conflicts serialize execution, not the operator's authorization.
  // Include other independent roots contending for a selected root's scope
  // before expanding the dependency wave. Unrelated roots stay outside it.
  const selectedRootFiles = new Set(issues
    .filter((issue) => selectedIds.has(issue.id) && issue.dependencies.length === 0)
    .flatMap((issue) => issue.targetFiles));
  for (const issue of issues) {
    if (issue.dependencies.length === 0 && issue.targetFiles.some((file) => selectedRootFiles.has(file))) {
      selectedIds.add(issue.id);
    }
  }
  let added = true;
  while (added) {
    added = false;
    for (const issue of issues) {
      if (selectedIds.has(issue.id)) continue;
      const dependsOnSelectedIssue = issue.dependencies.some((dependency) => {
        const resolvedId = idsByDependencyReference.get(dependency.trim().toUpperCase());
        return resolvedId !== undefined && selectedIds.has(resolvedId);
      });
      if (dependsOnSelectedIssue) {
        selectedIds.add(issue.id);
        added = true;
      }
    }
  }
  return selectedIds;
}

function isEligibleForStartApproval(issue: ParsedIssueMetadata): boolean {
  if (!issue.orchestratorManaged || issue.openQuestions || isDelegatedReviewChild(issue)) {
    return false;
  }

  switch (issue.status) {
    case "backlog":
    case "todo":
      return true;
    case "in_progress":
    case "in_review":
    case "done":
    case "cancelled":
    case "blocked":
    case "unknown":
      return false;
  }
}

function compareStartApprovalCandidates(a: ParsedIssueMetadata, b: ParsedIssueMetadata): number {
  const priorityOrder = b.priorityRank - a.priorityRank;
  if (priorityOrder !== 0) return priorityOrder;

  return issueOrderKey(a).localeCompare(issueOrderKey(b));
}

function issueOrderKey(issue: Pick<ParsedIssueMetadata, "id" | "identifier">): string {
  return issue.identifier ?? issue.id;
}
