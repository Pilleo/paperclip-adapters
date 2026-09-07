/**
 * Select legacy Jules review artifacts for retirement after the parent PR is
 * verified. These children are read from the parent's authoritative children
 * route because Paperclip-created children may not inherit the workspace
 * projectId and therefore do not appear in a project-scoped issue list.
 */

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const LEGACY_MARKERS = /jules-session-supervisor|jules-question-adjudication/;

export interface ReviewChildSnapshot {
  readonly id?: unknown;
  readonly parentId?: unknown;
  readonly status?: unknown;
  readonly originKind?: unknown;
  readonly description?: unknown;
}

function isStaleReviewArtifact(parentId: string, child: ReviewChildSnapshot): boolean {
  if (typeof child.id !== "string" || child.id.length === 0) return false;
  // The `/issues/:parentId/children` route already establishes ownership;
  // Paperclip versions in the wild may omit parentId from these child records.
  if (child.parentId !== undefined && child.parentId !== parentId) return false;
  if (typeof child.status !== "string" || TERMINAL_STATUSES.has(child.status.toLowerCase())) return false;
  return child.originKind === "issue_productivity_review" ||
    (typeof child.description === "string" && LEGACY_MARKERS.test(child.description));
}

export function selectStaleJulesReviewChildren(
  parentId: string,
  children: readonly ReviewChildSnapshot[],
): string[] {
  const ids = new Set<string>();
  for (const child of children) {
    if (isStaleReviewArtifact(parentId, child)) ids.add(child.id as string);
  }
  return [...ids].sort();
}
