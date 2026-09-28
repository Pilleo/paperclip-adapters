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
    targetFile: canaryTargetFile(runKey, "increment"),
    body: "Export increment(n) from the declared CommonJS implementation file. For a finite integer input return n + 1 without mutating anything: increment(2) returns 3, increment(0) returns 1, and increment(-1) returns 0. Throw TypeError on non-number or non-finite input. Add Node's built-in node:test coverage in the declared test file, including the examples and invalid input. Run `node --test " + canaryTestFile(runKey, "increment") + "` and expect all cases to pass before opening the PR.",
  });
}

export function buildCanaryB(projectId: string, runKey: string, aId: string): Record<string, unknown> {
  return {
    ...buildCanaryIssue(projectId, runKey, {
      title: "Canary B: implement decrement",
      priority: "medium",
    targetFile: canaryTargetFile(runKey, "decrement"),
    body: "After A merges, export decrement(n) from the declared CommonJS implementation file. For a finite integer input return n - 1: decrement(2) returns 1, decrement(0) returns -1. Throw TypeError on non-number or non-finite input. Test these cases with node:test in the declared test file. Run `node --test " + canaryTestFile(runKey, "decrement") + "` and expect all tests to pass.",
    }),
    blockedByIssueIds: [aId],
  };
}

export function buildCanaryC(projectId: string, runKey: string, bId: string): Record<string, unknown> {
  return {
    ...buildCanaryIssue(projectId, runKey, {
      title: "Canary C: implement is-zero",
      priority: "low",
    targetFile: canaryTargetFile(runKey, "is-zero"),
    body: "After B merges, export isZero(n) from the declared CommonJS implementation file. Return true only for numeric 0 and -0; return false for 1 and -1; throw TypeError on non-number input. Cover all these cases in the declared node:test file. Run `node --test " + canaryTestFile(runKey, "is-zero") + "` and expect all tests to pass.",
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
    // Paperclip's create endpoint can deduplicate a same-title card even when
    // its requested dependency and target file differ. The run marker must be
    // part of the card identity, not only its description, or a new B/C can
    // silently resolve to an older canary and break the native dependency DAG.
    title: `${input.title} [e2e:${runKey}]`,
    // The metadata contract must be the first Markdown block.  Jules shares
    // this description with the orchestrator but parses strict front matter,
    // whereas the E2E run marker is only an audit annotation.
    description: `---\norchestrator_managed: true\ncomponent: "core"\ntarget_files: ["${input.targetFile}", "${input.targetFile.replace(/\.js$/, ".test.js")}"]\n---\n<!-- paperclip-adapters:e2e-run:${runKey} -->\n\n${input.body}`,
    projectId,
    status: "todo",
    priority: input.priority,
    // The disposable repository intentionally has no GitHub Actions workflow.
    // Keep fleet-wide Jules CI requirements intact while making this explicit
    // E2E fixture review-eligible after its focused provider-side test passes.
    assigneeAdapterOverrides: { adapterConfig: { ciPolicy: "skip" } },
  };
}

/**
 * The disposable repository is deliberately reused.  A fixed filename makes
 * every later canary ask Jules to reimplement already-merged work, producing
 * a legitimate no-change plan rather than an end-to-end implementation proof.
 * Keep every run's scope unique while making only a safe file-name fragment
 * from the server-generated run key.
 */
function canaryTargetFile(runKey: string, capability: string): string {
  const safeRunKey = runKey.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
  return `canary-${safeRunKey}-${capability}.js`;
}

function canaryTestFile(runKey: string, capability: string): string {
  return canaryTargetFile(runKey, capability).replace(/\.js$/, ".test.js");
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
