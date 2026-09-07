import { ParsedIssueMetadata } from "./types.js";

/**
 * Review children are durable state-machine actors. Generic orchestrator
 * recovery cannot safely infer that a reviewer is dead from issue age: ACP
 * runs can be long-lived, blocked on a dependency, or waiting for a heartbeat.
 */
export function isDelegatedReviewChild(issue: Pick<ParsedIssueMetadata, "parentId" | "rawIssue" | "isDelegatedReviewChild">): boolean {
  if (issue.isDelegatedReviewChild) return true;
  const description = issue.rawIssue?.["description"];
  return Boolean(typeof description === "string" && /<!-- jules-(?:plan-review|question-adjudication):/.test(description));
}

export function hasDelegatedReviewChild(issueId: string, issues: readonly ParsedIssueMetadata[]): boolean {
  return issues.some((issue) =>
    issue.parentId === issueId &&
    isDelegatedReviewChild(issue) &&
    issue.status !== "done" &&
    issue.status !== "cancelled",
  );
}

/** True when this parent has ever had an ACP review child, including terminal children. */
export function hasDelegatedReviewHistory(issueId: string, issues: readonly ParsedIssueMetadata[]): boolean {
  return issues.some((issue) => issue.parentId === issueId && isDelegatedReviewChild(issue));
}
