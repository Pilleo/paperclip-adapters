import { normalizeGitHubOwnerRepo } from "./parser.js";

type ProjectLike = {
  readonly id?: unknown;
  readonly primaryWorkspace?: {
    readonly sourceType?: unknown;
    readonly repoUrl?: unknown;
    readonly defaultRef?: unknown;
  } | null;
  readonly codebase?: {
    readonly effectiveLocalFolder?: unknown;
  } | null;
};

export type ProjectBackedGitWorkspaceResult =
  | { readonly ok: true; readonly workspacePath: string }
  | { readonly ok: false; readonly reason: "missing_primary_git_workspace" | "repository_mismatch" | "default_ref_mismatch" | "missing_managed_checkout" };

/**
 * The real-provider canary may execute only in a checkout selected by its
 * Paperclip project. This rejects local-path and issue-level repository
 * fallbacks so it exercises the same ownership model as production tasks.
 */
export function assertProjectBackedGitWorkspace(
  project: ProjectLike,
  expectedRepoUrl: string,
  expectedDefaultRef: string,
): ProjectBackedGitWorkspaceResult {
  const workspace = project.primaryWorkspace;
  if (!workspace || workspace.sourceType !== "git_repo") return { ok: false, reason: "missing_primary_git_workspace" };
  if (normalizeGitHubOwnerRepo(typeof workspace.repoUrl === "string" ? workspace.repoUrl : undefined) !== normalizeGitHubOwnerRepo(expectedRepoUrl)) {
    return { ok: false, reason: "repository_mismatch" };
  }
  if (workspace.defaultRef !== expectedDefaultRef) return { ok: false, reason: "default_ref_mismatch" };
  const workspacePath = typeof project.codebase?.effectiveLocalFolder === "string" ? project.codebase.effectiveLocalFolder.trim() : "";
  return workspacePath ? { ok: true, workspacePath } : { ok: false, reason: "missing_managed_checkout" };
}
