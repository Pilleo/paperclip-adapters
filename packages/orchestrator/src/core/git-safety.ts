import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PrMergeabilityInfo {
  readonly prNumber: number;
  readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | string;
  readonly mergeStateStatus?: string | undefined; // "CLEAN" | "DIRTY" | "BLOCKED" | "BEHIND" | "UNKNOWN"
  readonly headRefName?: string | undefined;
  readonly baseRefName?: string | undefined;
}

export interface MergeSafetyDecision {
  readonly canMerge: boolean;
  readonly isConflicting: boolean;
  readonly reason: string;
  readonly remediation?: string | undefined;
}

/**
 * Pure evaluator for PR merge safety and conflict detection.
 */
export function evaluatePrMergeability(info: PrMergeabilityInfo): MergeSafetyDecision {
  const isConflicting =
    info.mergeable === "CONFLICTING" || info.mergeStateStatus === "DIRTY";

  if (isConflicting) {
    return {
      canMerge: false,
      isConflicting: true,
      reason: `PR #${info.prNumber} has merge conflicts with base branch '${info.baseRefName || "master"}'.`,
      remediation: `Please rebase branch '${info.headRefName || "feature"}' on origin/${info.baseRefName || "master"} and resolve conflicts.`,
    };
  }

  const mergeableUnknown =
    info.mergeable === "UNKNOWN" ||
    !info.mergeable ||
    info.mergeStateStatus === "UNKNOWN" ||
    info.mergeStateStatus === "BLOCKED" ||
    info.mergeStateStatus === "BEHIND";

  if (mergeableUnknown && info.mergeable !== "MERGEABLE") {
    return {
      canMerge: false,
      isConflicting: false,
      reason: `PR #${info.prNumber} mergeability is "${info.mergeable}" (${info.mergeStateStatus || "UNKNOWN"}). Refusing to merge.`,
      remediation: `Wait for GitHub to report MERGEABLE/CLEAN, then retry.`,
    };
  }

  return {
    canMerge: true,
    isConflicting: false,
    reason: `PR #${info.prNumber} is mergeable (${info.mergeStateStatus || "CLEAN"}).`,
  };
}

/**
 * Fetches live PR mergeability and state status via GitHub CLI.
 */
export async function checkPrMergeability(
  prNumber: number,
  cwd: string = process.cwd()
): Promise<PrMergeabilityInfo> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", String(prNumber), "--json", "mergeable,mergeStateStatus,headRefName,baseRefName"],
      { cwd }
    );

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      prNumber,
      mergeable: typeof parsed["mergeable"] === "string" ? parsed["mergeable"] : "UNKNOWN",
      mergeStateStatus: typeof parsed["mergeStateStatus"] === "string" ? parsed["mergeStateStatus"] : "UNKNOWN",
      headRefName: typeof parsed["headRefName"] === "string" ? parsed["headRefName"] : undefined,
      baseRefName: typeof parsed["baseRefName"] === "string" ? parsed["baseRefName"] : "master",
    };
  } catch {
    return {
      prNumber,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    };
  }
}
