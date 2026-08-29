import { GitHubPullRequest } from "./types.js";

export interface BranchPruneResult {
  readonly prNumber: number;
  readonly branchName: string;
  readonly isMerged: boolean;
  readonly action: "prunable" | "active";
}

/**
 * Identifies remote feature branches that have been merged and are ready for pruning.
 */
export function identifyMergedBranches(
  mergedPrs: readonly GitHubPullRequest[]
): readonly BranchPruneResult[] {
  const results: BranchPruneResult[] = [];

  for (const pr of mergedPrs) {
    if (pr.mergedAt && pr.headRefName && pr.headRefName !== "master" && pr.headRefName !== "main") {
      results.push({
        prNumber: pr.number,
        branchName: pr.headRefName,
        isMerged: true,
        action: "prunable",
      });
    }
  }

  return Object.freeze(results);
}
