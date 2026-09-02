import fs from "node:fs";
import type { PaperclipProjectRecord, ProjectWorkspaceResolution } from "./parser.js";
import { resolveProjectWorkspace } from "./parser.js";

export interface ProjectIssueRecord {
  readonly id: string;
  readonly projectId?: string | null | undefined;
  readonly [key: string]: unknown;
}

export interface ProjectWorkspaceGroup {
  readonly project: PaperclipProjectRecord;
  readonly workspacePath: string;
  readonly issues: readonly ProjectIssueRecord[];
}

export interface ProjectWorkspacePartition {
  readonly groups: readonly ProjectWorkspaceGroup[];
  readonly rejected: readonly {
    readonly issue: ProjectIssueRecord;
    readonly resolution: Extract<ProjectWorkspaceResolution, { readonly ok: false }>;
  }[];
}

export function isProjectWorkspaceDirectory(workspacePath: string): boolean {
  try {
    return fs.statSync(workspacePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build independent scheduling units from issue-owned projects.
 *
 * The returned groups are intentionally immutable and contain no fallback
 * workspace. This makes it safe for a company heartbeat to process several
 * repositories without sharing GitHub locks or local checkout state.
 */
export function partitionIssuesByProject(params: {
  readonly issues: readonly ProjectIssueRecord[];
  readonly projects: readonly PaperclipProjectRecord[];
}): ProjectWorkspacePartition {
  const groups = new Map<string, { project: PaperclipProjectRecord; workspacePath: string; issues: ProjectIssueRecord[] }>();
  const rejected: ProjectWorkspacePartition["rejected"][number][] = [];

  for (const issue of params.issues) {
    const resolution = resolveProjectWorkspace({
      projectId: issue.projectId,
      projects: params.projects,
    });
    if (!resolution.ok) {
      rejected.push(Object.freeze({ issue, resolution }));
      continue;
    }
    const existing = groups.get(resolution.project.id);
    if (existing) {
      existing.issues.push(issue);
    } else {
      groups.set(resolution.project.id, {
        project: resolution.project,
        workspacePath: resolution.workspacePath,
        issues: [issue],
      });
    }
  }

  return {
    groups: Object.freeze([...groups.values()].map((group) => Object.freeze({
      project: group.project,
      workspacePath: group.workspacePath,
      issues: Object.freeze([...group.issues]),
    }))),
    rejected: Object.freeze(rejected),
  };
}
