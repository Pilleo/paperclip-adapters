import type { StressTask } from "./stress-campaign-manifest.js";

export const STRESS_PROJECT_MARKER = "<!-- paperclip-adapters:stress-project:v1 -->";

type RecordLike = Readonly<Record<string, unknown>>;

export type StressProjectSelection =
  | { readonly kind: "missing" }
  | { readonly kind: "found"; readonly project: RecordLike }
  | { readonly kind: "invalid"; readonly reason: string };

export function selectStressProject(projects: readonly RecordLike[], runKey: string, explicitProjectId?: string): StressProjectSelection {
  const marked = projects.filter((project) => typeof project["description"] === "string" && project["description"].includes(STRESS_PROJECT_MARKER));
  if (marked.length === 0) return { kind: "missing" };
  if (marked.length !== 1) return { kind: "invalid", reason: "ambiguous_stress_project" };
  const project = marked[0]!;
  if (typeof project["id"] !== "string" || !project["id"] ||
      (explicitProjectId && project["id"] !== explicitProjectId) ||
      typeof project["name"] !== "string" || (!explicitProjectId && !project["name"].includes(`[stress:${runKey}]`))) {
    return { kind: "invalid", reason: "different_or_malformed_stress_project" };
  }
  return { kind: "found", project };
}

/** A new run cannot coexist with an unfinished original run in this project. */
export function assertStressProjectReadyForRun(
  issues: readonly RecordLike[], runKey: string,
): { readonly ok: true } | { readonly ok: false; readonly blockingIssueIds: readonly string[] } {
  const blockerIds = issues.flatMap((issue) => {
    const description = issue["description"];
    if (typeof description !== "string") return [];
    const previous = /<!-- paperclip-adapters:stress-run:([^\s>]+) -->/.exec(description)?.[1];
    if (!previous || previous === runKey || issue["status"] === "done" || issue["status"] === "cancelled") return [];
    return [String(issue["id"] ?? "missing")];
  });
  return blockerIds.length ? { ok: false, blockingIssueIds: blockerIds } : { ok: true };
}

function blockers(detail: RecordLike): readonly string[] {
  const raw = detail["blockedBy"];
  if (!Array.isArray(raw)) throw new Error("Native blockedBy relation absent");
  return raw.map((item: unknown) => {
    if (!item || typeof item !== "object" || typeof (item as RecordLike)["id"] !== "string") {
      throw new Error("Malformed native blockedBy relation");
    }
    return (item as RecordLike)["id"] as string;
  });
}

/** Compare authoritative detail, never assume a successful POST means a persisted DAG. */
export function assertStressReadback(
  task: StressTask,
  expected: RecordLike,
  detail: RecordLike,
  allowedStatus: "backlog" | "todo" = "backlog",
): void {
  if (typeof detail["id"] !== "string" || !detail["id"] ||
      detail["projectId"] !== expected["projectId"] || detail["title"] !== expected["title"] ||
      detail["description"] !== expected["description"] || detail["status"] !== allowedStatus) {
    throw new Error(`Stress task ${task.key} persisted with an unexpected identity or contract`);
  }
  const expectedIds = expected["blockedByIssueIds"];
  if (!Array.isArray(expectedIds) || new Set(expectedIds).size !== expectedIds.length) {
    throw new Error(`Stress task ${task.key} has invalid expected native blocker IDs`);
  }
  const actualIds = blockers(detail);
  if (actualIds.length !== expectedIds.length || new Set(actualIds).size !== actualIds.length ||
      actualIds.some((id) => !expectedIds.includes(id))) {
    throw new Error(`Stress task ${task.key} has inconsistent native blockedBy IDs`);
  }
}

export type StressIssueDecision =
  | { readonly kind: "create" }
  | { readonly kind: "resume"; readonly issueId: string }
  | { readonly kind: "stop"; readonly reason: string };

/** Caller must supply authoritative issue details for title+marker matches. */
export function stressIssueDecision(
  issues: readonly RecordLike[], task: StressTask, expected: RecordLike,
  allowedStatus: "backlog" | "todo" | "either" = "backlog",
): StressIssueDecision {
  const matches = issues.filter((issue) => issue["title"] === expected["title"] ||
    (typeof issue["description"] === "string" &&
      issue["description"].includes(`<!-- paperclip-adapters:stress-run:${task.runKey} -->`) &&
      issue["description"].includes(`<!-- paperclip-adapters:stress-task:${task.key} -->`)));
  if (matches.length === 0) return { kind: "create" };
  if (matches.length !== 1) return { kind: "stop", reason: "duplicate_task_identity" };
  try {
    const status = allowedStatus === "either" ? matches[0]!["status"] : allowedStatus;
    if (status !== "backlog" && status !== "todo") throw new Error("Unexpected task status during activation");
    assertStressReadback(task, expected, matches[0]!, status);
  } catch (error) {
    return { kind: "stop", reason: error instanceof Error ? error.message : "invalid_readback" };
  }
  return { kind: "resume", issueId: matches[0]!["id"] as string };
}
