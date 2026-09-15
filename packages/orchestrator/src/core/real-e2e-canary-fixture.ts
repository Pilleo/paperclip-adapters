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
