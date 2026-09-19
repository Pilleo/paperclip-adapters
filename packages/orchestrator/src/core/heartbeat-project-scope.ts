import type { PaperclipProjectRecord } from "./parser.js";

export type HeartbeatScopeReference =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "issue"; readonly issueId: string }
  | { readonly kind: "approval"; readonly approvalId: string }
  | { readonly kind: "invalid_explicit_scope" }
  | { readonly kind: "unscoped_timer" };

/**
 * Paperclip currently retains `wakeReason` when it coalesces an on-demand
 * wake into a timer run, but drops custom payload fields such as `projectId`.
 * This deliberately narrow envelope preserves project ownership until the
 * server persists arbitrary wake payloads. Only the adapter's explicit
 * on-demand wakes may use it; malformed envelopes fail closed.
 */
export const EXPLICIT_PROJECT_WAKE_REASON_PREFIX = "paperclip-orchestrator-scope/v1/project/";

export type HeartbeatScopeAuthorityInvalidReason =
  | "missing_run_id"
  | "invalid_run_record"
  | "run_identity_mismatch"
  | "agent_identity_mismatch"
  | "missing_context_snapshot"
  | "malformed_explicit_scope"
  | "unscoped_on_demand"
  | "missing_timer_evidence"
  | "scope_conflict";

export type HeartbeatScopeAuthorityDecision =
  | { readonly kind: "resolved"; readonly reference: Exclude<HeartbeatScopeReference, { readonly kind: "invalid_explicit_scope" }> }
  | { readonly kind: "invalid"; readonly reason: HeartbeatScopeAuthorityInvalidReason };

export interface HeartbeatRunScopeRecord {
  readonly id?: unknown;
  readonly agentId?: unknown;
  readonly contextSnapshot?: unknown;
}

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
      | "cross_project_approval"
      | "invalid_explicit_scope";
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExplicitScope(reference: HeartbeatScopeReference): reference is Exclude<HeartbeatScopeReference, { readonly kind: "invalid_explicit_scope" } | { readonly kind: "unscoped_timer" }> {
  return reference.kind === "project" || reference.kind === "issue" || reference.kind === "approval";
}

function sameExplicitScope(
  left: Exclude<HeartbeatScopeReference, { readonly kind: "invalid_explicit_scope" } | { readonly kind: "unscoped_timer" }>,
  right: Exclude<HeartbeatScopeReference, { readonly kind: "invalid_explicit_scope" } | { readonly kind: "unscoped_timer" }>,
): boolean {
  switch (left.kind) {
    case "project":
      return right.kind === "project" && left.projectId === right.projectId;
    case "issue":
      return right.kind === "issue" && left.issueId === right.issueId;
    case "approval":
      return right.kind === "approval" && left.approvalId === right.approvalId;
  }
}

function isPositiveSchedulerTimer(context: Readonly<Record<string, unknown>>): boolean {
  return readString(context["wakeSource"]) !== "on_demand"
    && readString(context["source"]) === "scheduler"
    && readString(context["reason"]) === "interval_elapsed";
}

export function parseHeartbeatScopeReference(context: Readonly<Record<string, unknown>>): HeartbeatScopeReference {
  const projectId = readString(context["projectId"]);
  if (projectId) return { kind: "project", projectId };

  const issueId = readString(context["issueId"]) ?? readString(context["taskId"]);
  if (issueId) return { kind: "issue", issueId };

  const approvalId = readString(context["approvalId"]);
  if (approvalId) return { kind: "approval", approvalId };

  const wakeReason = readString(context["wakeReason"]);
  if (readString(context["wakeSource"]) === "on_demand" && wakeReason?.startsWith(EXPLICIT_PROJECT_WAKE_REASON_PREFIX)) {
    const scopedProjectId = wakeReason.slice(EXPLICIT_PROJECT_WAKE_REASON_PREFIX.length).trim();
    return scopedProjectId
      ? { kind: "project", projectId: scopedProjectId }
      : { kind: "invalid_explicit_scope" };
  }

  return { kind: "unscoped_timer" };
}

/**
 * Adapter invocation context is a projection and may omit the project scope
 * when Paperclip coalesces wakes. The run snapshot is server-owned and is the
 * authority boundary for every non-test orchestrator heartbeat. An absent or
 * contradictory snapshot must never expand work to the whole company.
 */
export function classifyAuthoritativeHeartbeatScope(input: {
  readonly runId: string | null | undefined;
  readonly agentId: string;
  readonly invocationContext: Readonly<Record<string, unknown>>;
  readonly run: HeartbeatRunScopeRecord;
}): HeartbeatScopeAuthorityDecision {
  const runId = readString(input.runId);
  if (!runId) return { kind: "invalid", reason: "missing_run_id" };
  if (!isRecord(input.run)) return { kind: "invalid", reason: "invalid_run_record" };
  if (readString(input.run["id"]) !== runId) return { kind: "invalid", reason: "run_identity_mismatch" };
  if (readString(input.run["agentId"]) !== readString(input.agentId)) {
    return { kind: "invalid", reason: "agent_identity_mismatch" };
  }
  if (!isRecord(input.run["contextSnapshot"])) return { kind: "invalid", reason: "missing_context_snapshot" };

  const authoritativeContext = input.run["contextSnapshot"];
  const authoritativeReference = parseHeartbeatScopeReference(authoritativeContext);
  const invocationReference = parseHeartbeatScopeReference(input.invocationContext);
  if (authoritativeReference.kind === "invalid_explicit_scope" || invocationReference.kind === "invalid_explicit_scope") {
    return { kind: "invalid", reason: "malformed_explicit_scope" };
  }

  if (isExplicitScope(authoritativeReference)) {
    if (isExplicitScope(invocationReference) && !sameExplicitScope(authoritativeReference, invocationReference)) {
      return { kind: "invalid", reason: "scope_conflict" };
    }
    return { kind: "resolved", reference: authoritativeReference };
  }

  if (readString(authoritativeContext["wakeSource"]) === "on_demand") {
    return { kind: "invalid", reason: "unscoped_on_demand" };
  }

  if (isPositiveSchedulerTimer(authoritativeContext)) {
    if (isExplicitScope(invocationReference)) return { kind: "invalid", reason: "scope_conflict" };
    return { kind: "resolved", reference: { kind: "unscoped_timer" } };
  }

  return { kind: "invalid", reason: "missing_timer_evidence" };
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
    case "invalid_explicit_scope":
      return { kind: "invalid", reason: "invalid_explicit_scope" };
    case "unscoped_timer":
      return { kind: "all_projects", projects: input.projects };
  }
}
