import type { PaperclipProjectRecord } from "./parser.js";

export type HeartbeatScopeReference =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "issue"; readonly issueId: string }
  | { readonly kind: "approval"; readonly approvalId: string }
  | { readonly kind: "unscoped_timer" };

export type HeartbeatProjectSelection =
  | { readonly kind: "scoped"; readonly project: PaperclipProjectRecord }
  | { readonly kind: "all_projects"; readonly projects: readonly PaperclipProjectRecord[] }
  | {
    readonly kind: "invalid";
    readonly reason:
      | "unknown_project"
      | "unknown_issue"
      | "unknown_approval"
      | "missing_issue_project"
      | "cross_project_approval";
  };

export interface ApprovalScopeRecord {
  readonly id: string;
  readonly issueIds?: readonly string[] | null | undefined;
  readonly payload?: Readonly<Record<string, unknown>> | null | undefined;
}

export interface IssueScopeRecord {
  readonly id: string;
  readonly projectId?: string | null | undefined;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseHeartbeatScopeReference(context: Readonly<Record<string, unknown>>): HeartbeatScopeReference {
  const projectId = readString(context["projectId"]);
  if (projectId) return { kind: "project", projectId };

  const issueId = readString(context["issueId"]) ?? readString(context["taskId"]);
  if (issueId) return { kind: "issue", issueId };

  const approvalId = readString(context["approvalId"]);
  if (approvalId) return { kind: "approval", approvalId };

  return { kind: "unscoped_timer" };
}

export async function resolveHeartbeatProjectSelection(input: {
  readonly projects: readonly PaperclipProjectRecord[];
  readonly reference: HeartbeatScopeReference;
  readonly approvals: readonly ApprovalScopeRecord[];
  readonly getIssue: (issueId: string) => Promise<IssueScopeRecord>;
}): Promise<HeartbeatProjectSelection> {
  const selectProject = (projectId: string): HeartbeatProjectSelection => {
    const project = input.projects.find((candidate) => candidate.id === projectId);
    return project ? { kind: "scoped", project } : { kind: "invalid", reason: "unknown_project" };
  };

  const selectIssueProject = async (issueId: string): Promise<HeartbeatProjectSelection> => {
    let issue: IssueScopeRecord;
    try {
      issue = await input.getIssue(issueId);
    } catch {
      return { kind: "invalid", reason: "unknown_issue" };
    }
    const projectId = readString(issue.projectId);
    return projectId ? selectProject(projectId) : { kind: "invalid", reason: "missing_issue_project" };
  };

  switch (input.reference.kind) {
    case "project":
      return selectProject(input.reference.projectId);
    case "issue":
      return selectIssueProject(input.reference.issueId);
    case "approval": {
      const approvalId = input.reference.approvalId;
      const approval = input.approvals.find((candidate) => candidate.id === approvalId);
      if (!approval) return { kind: "invalid", reason: "unknown_approval" };
      const issueIds = new Set<string>();
      for (const issueId of approval.issueIds ?? []) {
        const normalized = readString(issueId);
        if (normalized) issueIds.add(normalized);
      }
      const payloadIssueId = readString(approval.payload?.["issueId"]);
      if (payloadIssueId) issueIds.add(payloadIssueId);
      if (issueIds.size !== 1) return { kind: "invalid", reason: "cross_project_approval" };
      return selectIssueProject([...issueIds][0]!);
    }
    case "unscoped_timer":
      return { kind: "all_projects", projects: input.projects };
  }
}
