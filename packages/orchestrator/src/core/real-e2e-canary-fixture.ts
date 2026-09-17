import { EXPLICIT_PROJECT_WAKE_REASON_PREFIX } from "./heartbeat-project-scope.js";

/**
 * The bootstrap wake needs an issue-to-project association, but it must never
 * compete with the real canary tasks.  A live, unscoped bootstrap issue is
 * interpreted as a broad conflict by the scheduler and suppresses the test
 * before it reaches its first approval.  Keep the anchor terminal from its
 * creation while retaining the project-scoped wake contract.
 */
export function buildDisposableCanaryBootstrapIssue(projectId: string): Record<string, unknown> {
  return {
    title: "Canary bootstrap: reconcile this project",
    description: "Internal real-provider E2E scheduler anchor. It is terminal by design and must not reserve implementation scope.",
    projectId,
    status: "done",
    priority: "low",
    assigneeAgentId: null,
    executionPolicy: null,
    executionState: null,
  };
}

export function buildCanaryA(projectId: string, runKey: string): Record<string, unknown> {
  return buildCanaryIssue(projectId, runKey, {
    title: "Canary A: implement increment",
    priority: "high",
    targetFile: "increment.js",
    body: "Implement the increment helper and its focused behavioral test.",
  });
}

export function buildCanaryB(projectId: string, runKey: string, aId: string): Record<string, unknown> {
  return {
    ...buildCanaryIssue(projectId, runKey, {
      title: "Canary B: implement decrement",
      priority: "medium",
      targetFile: "decrement.js",
      body: "Implement the decrement helper and its focused behavioral test after Canary A merges.",
    }),
    blockedByIssueIds: [aId],
  };
}

export function buildCanaryC(projectId: string, runKey: string, bId: string): Record<string, unknown> {
  return {
    ...buildCanaryIssue(projectId, runKey, {
      title: "Canary C: implement is-zero",
      priority: "low",
      targetFile: "is-zero.js",
      body: "Implement the zero predicate and its focused behavioral test after Canary B merges.",
    }),
    blockedByIssueIds: [bId],
  };
}

/**
 * Paperclip may coalesce an on-demand wake and omit its payload from the
 * adapter invocation. The adapter resolves this envelope from the
 * server-owned heartbeat run snapshot, so the canary remains project-scoped.
 */
export function buildCanaryOrchestratorWake(projectId: string, runKey: string): Record<string, unknown> {
  return {
    source: "on_demand",
    reason: `${EXPLICIT_PROJECT_WAKE_REASON_PREFIX}${projectId}`,
    idempotencyKey: `real-project-canary:${projectId}:${runKey}`,
    payload: { projectId },
  };
}

function buildCanaryIssue(
  projectId: string,
  runKey: string,
  input: { readonly title: string; readonly priority: string; readonly targetFile: string; readonly body: string },
): Record<string, unknown> {
  return {
    title: input.title,
    description: `<!-- paperclip-adapters:e2e-run:${runKey} -->\n---\norchestrator_managed: true\ncomponent: "core"\ntarget_files: ["${input.targetFile}"]\n---\n\n${input.body}`,
    projectId,
    status: "todo",
    priority: input.priority,
  };
}

export function assertAuthoritativeCanaryChain(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  c: Record<string, unknown>,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (!hasOnlyBlocker(b, String(a["id"] ?? ""))) return { ok: false, reason: "b_missing_authoritative_blocker" };
  if (!hasOnlyBlocker(c, String(b["id"] ?? ""))) return { ok: false, reason: "c_missing_authoritative_blocker" };
  return { ok: true };
}

function hasOnlyBlocker(issue: Record<string, unknown>, expectedId: string): boolean {
  const blockers = issue["blockedBy"];
  if (!Array.isArray(blockers) || blockers.length !== 1 || !expectedId) return false;
  const blocker = blockers[0];
  return typeof blocker === "object" && blocker !== null && (blocker as Record<string, unknown>)["id"] === expectedId;
}
