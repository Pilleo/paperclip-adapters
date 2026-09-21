export const E2E_PROJECT_MARKER = "<!-- paperclip-adapters:e2e-project:v2 -->";
const E2E_RUN_MARKER = /<!-- paperclip-adapters:e2e-run:[^\s>]+ -->/;

export interface DisposableProjectRecord {
  readonly id: string;
  readonly description?: string | null | undefined;
}

export type DisposableProjectSelection =
  | { readonly kind: "create" }
  | { readonly kind: "reuse"; readonly project: DisposableProjectRecord }
  | { readonly kind: "invalid_duplicate"; readonly projectIds: readonly string[] };

export type ExistingDisposableProjectSelection =
  | { readonly kind: "reuse"; readonly project: DisposableProjectRecord }
  | { readonly kind: "invalid_missing"; readonly projectId: string };

/**
 * Live E2E runs deliberately name the already-provisioned Paperclip project.
 * Never infer by description or create a replacement during an execution run:
 * doing so hides a broken fixture selection behind extra infrastructure.
 */
export function selectExistingDisposableProject(
  projects: readonly DisposableProjectRecord[],
  projectId: string,
): ExistingDisposableProjectSelection {
  const project = projects.find((candidate) => candidate.id === projectId);
  return project ? { kind: "reuse", project } : { kind: "invalid_missing", projectId };
}

export function ensureSingleDisposableProject(
  projects: readonly DisposableProjectRecord[],
): DisposableProjectSelection {
  const marked = projects.filter((project) => project.description?.includes(E2E_PROJECT_MARKER) === true);
  switch (marked.length) {
    case 0:
      return { kind: "create" };
    case 1:
      return { kind: "reuse", project: marked[0]! };
    default:
      return { kind: "invalid_duplicate", projectIds: marked.map((project) => project.id) };
  }
}

export function assertProjectReadyForCanary(
  issues: readonly { readonly id: string; readonly status: string; readonly description?: string | null | undefined }[],
): { readonly ok: true } | { readonly ok: false; readonly blockingIssueIds: readonly string[] } {
  const blockingIssueIds = issues
    .filter((issue) => typeof issue.description === "string" && E2E_RUN_MARKER.test(issue.description) && !isTerminal(issue.status))
    .map((issue) => issue.id);
  return blockingIssueIds.length === 0 ? { ok: true } : { ok: false, blockingIssueIds };
}

/**
 * The company-wide issues route is paginated. A canary safety check must read
 * the exact project with an explicit limit, otherwise an older unfinished B/C
 * can be omitted and a new A is created beside it.
 */
export function canaryProjectIssuesPath(companyId: string, projectId: string): string {
  const query = new URLSearchParams({ projectId, limit: "200" });
  return `/api/companies/${encodeURIComponent(companyId)}/issues?${query.toString()}`;
}

function isTerminal(status: string): boolean {
  switch (status) {
    case "done":
    case "cancelled":
      return true;
    default:
      return false;
  }
}
