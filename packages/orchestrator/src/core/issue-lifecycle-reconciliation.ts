import type { ParsedIssueMetadata } from "./types.js";
import { isDelegatedReviewChild } from "./recovery-eligibility.js";

export type LifecycleReconciliationDecision =
  | { readonly action: "preserve" }
  | { readonly action: "close_diagnostic" | "close_duplicate_diagnostic" | "close_obsolete_review_child" | "reclaim_orphan_in_progress"; readonly status: "done" | "cancelled" | "todo"; readonly reason: string };

export interface LifecycleReconciliationOptions {
  readonly now?: () => number;
  /** Diagnostics are observations, not work items. Keep them visible briefly for inspection. */
  readonly diagnosticRetentionMs?: number;
}

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const DEFAULT_DIAGNOSTIC_RETENTION_MS = 6 * 60 * 60 * 1000;

function rawString(issue: ParsedIssueMetadata, key: string): string {
  const value = issue.rawIssue[key];
  return typeof value === "string" ? value : "";
}

function issueCreatedAt(issue: ParsedIssueMetadata): number {
  const raw = rawString(issue, "createdAt") || issue.updatedAt || "";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function hasActiveExecution(issue: ParsedIssueMetadata): boolean {
  if (issue.executionRunId) return true;
  const state = issue.rawIssue["executionState"];
  if (!state || typeof state !== "object") return false;
  const status = (state as Record<string, unknown>)["status"];
  return status === "queued" || status === "running" || status === "active" || status === "waiting";
}

function isDiagnostic(issue: ParsedIssueMetadata): boolean {
  const title = issue.title.toLowerCase();
  const description = rawString(issue, "description").toLowerCase();
  return (
    title.startsWith("review silent active run for ") ||
    title.startsWith("review productivity for ") ||
    description.includes("paperclip detected critical output silence") ||
    description.includes("paperclip detected an unusual productivity/progression pattern")
  );
}

function diagnosticKind(issue: ParsedIssueMetadata): "silence" | "productivity" | null {
  const title = issue.title.toLowerCase();
  const description = rawString(issue, "description").toLowerCase();
  if (title.startsWith("review silent active run for ") || description.includes("critical output silence")) return "silence";
  if (title.startsWith("review productivity for ") || description.includes("unusual productivity/progression")) return "productivity";
  return null;
}

function sourceIdentity(issue: ParsedIssueMetadata): string {
  const description = rawString(issue, "description");
  const run = description.match(/(?:^|\n)\s*-?\s*run:\s*([^\s]+)/i)?.[1];
  if (run) return run.replace(/[)`].*$/, "");
  const source = description.match(/source issue:\s*\[([^\]]+)\]/i)?.[1];
  if (source) return source;
  const titleSource = issue.title.match(/for\s+(MAZ-\d+)$/i)?.[1];
  return titleSource || issue.parentId || issue.id;
}

/** Stable identity for deduplicating Paperclip-generated diagnostics. */
export function diagnosticStableKey(issue: ParsedIssueMetadata): string | null {
  const kind = diagnosticKind(issue);
  return kind ? `${kind}:${sourceIdentity(issue)}` : null;
}

function isCanonicalDiagnostic(issue: ParsedIssueMetadata, issues: readonly ParsedIssueMetadata[]): boolean {
  const key = diagnosticStableKey(issue);
  if (!key) return true;
  return issues
    .filter((candidate) => diagnosticStableKey(candidate) === key && !TERMINAL_STATUSES.has(candidate.status))
    .sort((a, b) => issueCreatedAt(a) - issueCreatedAt(b) || a.id.localeCompare(b.id))[0]?.id === issue.id;
}

function generatedAt(issue: ParsedIssueMetadata): number {
  const description = rawString(issue, "description");
  const match = description.match(/(?:generated at|started at|last output at):\s*([^\n]+)/i);
  const parsed = Date.parse(match?.[1]?.trim() || "");
  return Number.isFinite(parsed) ? parsed : issueCreatedAt(issue);
}

/**
 * Reconciles states created by Paperclip's monitor automations as well as
 * adapter-owned review children. This is deliberately pure: execute.ts owns
 * the writes and can therefore keep the operation idempotent and auditable.
 */
export function decideIssueLifecycleReconciliation(
  issue: ParsedIssueMetadata,
  issues: readonly ParsedIssueMetadata[],
  options: LifecycleReconciliationOptions = {},
): LifecycleReconciliationDecision {
  if (TERMINAL_STATUSES.has(issue.status)) return { action: "preserve" };

  if (isDiagnostic(issue)) {
    if (!isCanonicalDiagnostic(issue, issues)) {
      return { action: "close_duplicate_diagnostic", status: "cancelled", reason: "duplicate diagnostic for the same source run" };
    }
    const now = (options.now ?? Date.now)();
    const retention = options.diagnosticRetentionMs ?? DEFAULT_DIAGNOSTIC_RETENTION_MS;
    if (!hasActiveExecution(issue) && now - generatedAt(issue) >= retention) {
      return { action: "close_diagnostic", status: "done", reason: "stale Paperclip diagnostic has no active execution" };
    }
    return { action: "preserve" };
  }

  if (issue.status === "in_progress" && !issue.assigneeAgentId && !hasActiveExecution(issue)) {
    return { action: "reclaim_orphan_in_progress", status: "todo", reason: "in_progress issue has no assignee or active execution" };
  }

  if (isDelegatedReviewChild(issue) && issue.parentId) {
    const parent = issues.find((candidate) => candidate.id === issue.parentId);
    if (parent && TERMINAL_STATUSES.has(parent.status)) {
      return { action: "close_obsolete_review_child", status: "cancelled", reason: "parent is terminal" };
    }
  }

  return { action: "preserve" };
}
