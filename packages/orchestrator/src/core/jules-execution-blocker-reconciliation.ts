type UnknownRecord = Readonly<Record<string, unknown>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_RUN_STATUSES = new Set(["failed", "interrupted", "timed_out", "cancelled"]);
const RECOVERABLE_ISSUE_STATUSES = new Set(["blocked", "todo", "in_progress"]);

export interface JulesExecutionBlockerSnapshot {
  readonly issueId?: unknown;
  readonly companyId?: unknown;
  readonly issueStatus: unknown;
  readonly assigneeAgentId: unknown;
  readonly julesAgentId: unknown;
  readonly providerSessionId: unknown;
  readonly executionBlocker: unknown;
  readonly failedRun: unknown;
  readonly supersedingRuns?: readonly unknown[];
  readonly planObservationEvidence?: unknown;
}

export interface JulesExecutionBlockerPointer {
  readonly actionId: string;
  readonly runId: string;
  readonly providerSessionId: string;
  readonly agentId: string;
}

export type JulesExecutionBlockerRecovery =
  | {
      readonly action: "resolve_to_todo";
      readonly actionId: string;
      readonly runId: string;
      readonly providerSessionId: string;
      readonly recoveryBasis: "polling_failure" | "server_shutdown" | "superseding_success" | "plan_observation";
      readonly reason: string;
    }
  | { readonly action: "preserve"; readonly reason: string };

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function timestamp(value: unknown): number | null {
  const candidate = nonEmptyString(value);
  if (!candidate) return null;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Upgrade only the old pre-verdict state-poll failure, never an escaped write. */
function isLegacyPlanObservationFailure(snapshot: JulesExecutionBlockerSnapshot, pointer: JulesExecutionBlockerPointer,
  run: UnknownRecord): boolean {
  if (run["errorCode"] !== "native_child_plan_provider_state_conflict" ||
      run["error"] !== "Cannot continue the typed plan review (unverified_progress); same-session reconciliation is required.") return false;
  const companyId = nonEmptyString(snapshot.companyId);
  const issueId = nonEmptyString(snapshot.issueId);
  if (!companyId || !issueId || run["companyId"] !== companyId ||
      record(run["contextSnapshot"])?.["issueId"] !== issueId) return false;
  const evidence = record(snapshot.planObservationEvidence);
  const row = record(evidence?.["taskSession"]);
  const session = record(row?.["sessionParamsJson"]);
  const childReview = record(session?.["childPlanReview"]);
  const parsed = ChildPlanReviewIdentitySchema.safeParse(childReview?.["identity"]);
  if (!parsed.success) return false;
  const identity = parsed.data;
  if (row?.["companyId"] !== companyId || row["agentId"] !== pointer.agentId || row["adapterType"] !== "jules" ||
      row["taskKey"] !== issueId || row["lastRunId"] !== pointer.runId ||
      session?.["paperclipIssueId"] !== issueId || session["julesSessionId"] !== pointer.providerSessionId ||
      session["sessionId"] !== pointer.providerSessionId || session["phase"] !== "WAITING_FOR_PLAN_APPROVAL" ||
      session["julesState"] !== "IN_PROGRESS" || identity.companyId !== companyId || identity.parentIssueId !== issueId ||
      identity.sessionId !== pointer.providerSessionId || identity.julesAgentId !== pointer.agentId) return false;
  if (session["currentPrUrl"] != null || session["providerCreateIntent"] != null || session["pendingPlanRevisionRequest"] != null ||
      session["providerContinuation"] != null || session["questionAnswerIntent"] != null || session["planApprovedAt"] != null) return false;
  const journal = session["lifecycleEffectJournal"];
  if (journal != null && !(record(journal)?.["version"] === 1 && Array.isArray(record(journal)?.["effects"]) &&
      (record(journal)!["effects"] as unknown[]).length === 0)) return false;
  const mutation = session["mutationCheckpoint"];
  if (mutation != null && !(record(mutation)?.["status"] === "succeeded" && record(mutation)?.["operation"] === "save_plan_document" &&
      record(mutation)?.["issueId"] === issueId && record(mutation)?.["sessionId"] === pointer.providerSessionId &&
      record(mutation)?.["activityId"] === identity.activityId)) return false;
  const document = record(evidence?.["document"]);
  const child = record(evidence?.["child"]);
  if (!document || !child || !childReview) return false;
  const descriptor = parseChildPlanReviewDescription(child?.["description"]);
  if (!(document["id"] === identity.documentId && document["latestRevisionId"] === identity.revisionId &&
    document["latestRevisionNumber"] === identity.revisionNumber && nonEmptyString(childReview?.["childId"]) !== null &&
    child?.["id"] === childReview?.["childId"] && child["companyId"] === companyId && child["parentId"] === issueId &&
    child["createdByAgentId"] === pointer.agentId && child["executionBlocker"] == null &&
    descriptor !== null && childPlanReviewKey(descriptor) === childPlanReviewKey(identity))) return false;
  if (!Array.isArray(evidence?.["cards"]) || !Array.isArray(evidence["runs"])) return false;
  const runs = evidence["runs"].map(record);
  if (runs.some(run => !run || record(run["contextSnapshot"])?.["issueId"] === child["id"] &&
      (run["companyId"] !== companyId || !["succeeded", "cancelled"].includes(String(run["status"])) ||
        run["status"] === "cancelled" && run["startedAt"] !== null))) return false;
  const cards = evidence["cards"];
  if (cards.length === 0) return child["status"] === "backlog" && child["assigneeAgentId"] === identity.bootstrapAgentId;
  const bootstrapOwnedCard = child["assigneeAgentId"] === identity.bootstrapAgentId && child["status"] === "backlog" && record(cards[0])?.["status"] === "pending";
  if (cards.length !== 1 || !(child["assigneeAgentId"] === identity.reviewerAgentId || bootstrapOwnedCard) ||
      !["backlog", "blocked", "todo", "in_progress", "done"].includes(String(child["status"]))) return false;
  const card = record(cards[0]);
  const target = record(record(card?.["payload"])?.["target"]);
  if (!card || card["companyId"] !== companyId || card["issueId"] !== child["id"] || card["kind"] !== "request_item_verdicts" ||
      card["idempotencyKey"] !== childPlanReviewKey(identity) || card["addresseeAgentId"] !== identity.reviewerAgentId ||
      target?.["type"] !== "issue_document" || target["issueId"] !== issueId || target["key"] !== "plan" ||
      target["documentId"] !== identity.documentId || target["revisionId"] !== identity.revisionId || target["revisionNumber"] !== identity.revisionNumber) return false;
  const attributable = (id: unknown, agentId: string) => typeof id === "string" && runs.some(run => run !== null && run["id"] === id && run["companyId"] === companyId &&
    run["agentId"] === agentId && run["status"] === "succeeded" && record(run["contextSnapshot"])?.["issueId"] === child["id"]);
  if (!attributable(card["sourceRunId"], identity.bootstrapAgentId)) return false;
  if (card["status"] === "pending") return child["status"] !== "done";
  const result = record(card["result"]);
  const items = result?.["items"];
  const verdict = Array.isArray(items) && items.length === 1 ? record(items[0]) : null;
  return card["status"] === "answered" && (card["resolvedByAgentId"] == null || card["resolvedByAgentId"] === identity.reviewerAgentId) &&
    attributable(card["resolvedByRunId"], identity.reviewerAgentId) && result?.["outcome"] === "resolved" && result["complete"] === true &&
    verdict?.["id"] === "plan" && (verdict["verdict"] === "approve" || verdict["verdict"] === "reject" && nonEmptyString(verdict["reason"]) !== null);
}

function hasSupersedingSuccess(
  snapshot: JulesExecutionBlockerSnapshot,
  pointer: JulesExecutionBlockerPointer,
  failedRun: UnknownRecord,
): boolean {
  const issueId = nonEmptyString(snapshot.issueId);
  const failedAt = timestamp(failedRun["finishedAt"]);
  if (!issueId || failedAt === null || !Array.isArray(snapshot.supersedingRuns)) return false;
  return snapshot.supersedingRuns.some((candidate) => {
    const run = record(candidate);
    if (!run || run["status"] !== "succeeded") return false;
    if (run["agentId"] !== pointer.agentId || run["issueId"] !== issueId) return false;
    const startedAt = timestamp(run["startedAt"]);
    const finishedAt = timestamp(run["finishedAt"]);
    return startedAt !== null && finishedAt !== null && startedAt > failedAt && finishedAt >= startedAt;
  });
}

/**
 * Parse only the narrow Paperclip recovery hold that can safely be delegated
 * back to the Jules adapter. The durable session proves where continuation
 * lives; the recovery action and failed run UUIDs preserve Paperclip's typed
 * no-replay boundary until the server validates the reconciliation evidence.
 */
export function parseJulesExecutionBlockerPointer(
  snapshot: Omit<JulesExecutionBlockerSnapshot, "failedRun">,
): JulesExecutionBlockerPointer | null {
  if (!RECOVERABLE_ISSUE_STATUSES.has(String(snapshot.issueStatus ?? ""))) return null;
  const assigneeAgentId = nonEmptyString(snapshot.assigneeAgentId);
  const julesAgentId = nonEmptyString(snapshot.julesAgentId);
  if (!assigneeAgentId || assigneeAgentId !== julesAgentId) return null;
  const providerSessionId = nonEmptyString(snapshot.providerSessionId);
  if (!providerSessionId) return null;
  const blocker = record(snapshot.executionBlocker);
  if (blocker?.["cause"] !== "legacy_execution_requires_reconciliation") return null;
  const actionId = nonEmptyString(blocker["recoveryActionId"]);
  const runId = nonEmptyString(blocker["runId"]);
  const blockerAgentId = nonEmptyString(blocker["agentId"]);
  if (!actionId || !UUID.test(actionId) || !runId || !UUID.test(runId)) return null;
  if (blockerAgentId && blockerAgentId !== julesAgentId) return null;
  return { actionId, runId, providerSessionId, agentId: julesAgentId };
}

/**
 * Decide whether a legacy Paperclip execution hold belongs to a stopped Jules
 * polling turn. `jules_polling_error` and a graceful server-shutdown
 * interruption both mean the adapter did not establish a completed local
 * continuation; neither authorizes replaying remote work. The resulting
 * `mixed` reconciliation deliberately returns control to the Jules adapter,
 * which must inspect its persisted provider session first.
 */
export function decideJulesExecutionBlockerRecovery(
  snapshot: JulesExecutionBlockerSnapshot,
): JulesExecutionBlockerRecovery {
  const pointer = parseJulesExecutionBlockerPointer(snapshot);
  if (!pointer) return { action: "preserve", reason: "issue has no typed Jules execution blocker continuation" };
  const run = record(snapshot.failedRun);
  if (!run) return { action: "preserve", reason: "blocking run is unavailable" };
  if (run["id"] !== pointer.runId) return { action: "preserve", reason: "blocking run identity changed" };
  if (run["agentId"] !== pointer.agentId) return { action: "preserve", reason: "blocking run owner changed" };
  if (!TERMINAL_RUN_STATUSES.has(String(run["status"] ?? "")) || !nonEmptyString(run["finishedAt"])) {
    return { action: "preserve", reason: "blocking run is not terminal" };
  }
  const pollingFailure = run["errorCode"] === "jules_polling_error";
  // Paperclip records an in-flight native monitor as `interrupted` during a
  // graceful service restart. The persisted Jules session remains the only
  // authority for the next action, so leaving the server-owned hold in place
  // would permanently strand a resumable provider turn after every reload.
  const serverShutdownInterruption =
    run["status"] === "interrupted" && run["errorCode"] === "server_shutdown_interrupted";
  const supersedingSuccess = hasSupersedingSuccess(snapshot, pointer, run);
  const planObservation = isLegacyPlanObservationFailure(snapshot, pointer, run);
  if (!pollingFailure && !serverShutdownInterruption && !supersedingSuccess && !planObservation) {
    return { action: "preserve", reason: "blocking run did not fail in Jules polling" };
  }
  return {
    action: "resolve_to_todo",
    actionId: pointer.actionId,
    runId: pointer.runId,
    providerSessionId: pointer.providerSessionId,
    recoveryBasis: pollingFailure
      ? "polling_failure"
      : serverShutdownInterruption
        ? "server_shutdown"
        : planObservation ? "plan_observation" : "superseding_success",
    reason: pollingFailure
      ? "terminal Jules polling run left a durable provider continuation behind a legacy execution hold"
      : serverShutdownInterruption
        ? "Paperclip shutdown interrupted a Jules monitor while its durable provider continuation remained recorded"
        : planObservation ? "legacy read-only provider observation stranded the exact native plan review"
          : "terminal Jules run was superseded by a successful same-issue continuation",
  };
}

export function buildJulesExecutionReconciliationPayload(
  decision: Extract<JulesExecutionBlockerRecovery, { action: "resolve_to_todo" }>,
): Record<string, unknown> {
  return {
    actionId: decision.actionId,
    outcome: "restored",
    sourceIssueStatus: "todo",
    resolutionNote: `Jules run ${decision.runId} stopped locally; return the durable provider continuation to its adapter.`,
    executionReconciliation: {
      runId: decision.runId,
      // Paperclip's recovery endpoint defines this as acknowledgement that
      // its *local execution* stopped; v2026.916.0 validates only `true`.
      // The durable Jules provider handle stays in the issue document and the
      // `mixed` outcome below forces the adapter to inspect it before taking
      // any remote action. Sending `false` is rejected and strands the task.
      providerStopped: true,
      actionOutcome: "mixed",
      outcomeEvidence: decision.recoveryBasis === "polling_failure"
        ? `Jules polling run ${decision.runId} is terminal and durable session ${decision.providerSessionId} remains recorded. Remote action outcomes are intentionally treated as mixed; the Jules adapter must inspect that session before continuing.`
        : decision.recoveryBasis === "server_shutdown"
          ? `Paperclip shutdown interrupted Jules run ${decision.runId}; durable session ${decision.providerSessionId} remains recorded. Remote action outcomes are intentionally treated as mixed; the Jules adapter must inspect that session before continuing.`
          : decision.recoveryBasis === "plan_observation"
            ? `Jules run ${decision.runId} is terminal and its exact saved same-session plan checkpoint has no pending mutation. Resume native review observation on session ${decision.providerSessionId}; provider mutations remain gated by a fresh exact-plan observation and addressed typed verdict. Remote outcomes remain mixed, not inferred absent from a log.`
            : `Jules run ${decision.runId} is terminal, a newer successful same-issue Jules run superseded it, and durable session ${decision.providerSessionId} remains recorded. Remote action outcomes are intentionally treated as mixed; the Jules adapter must inspect that session before continuing.`,
    },
  };
}
import { ChildPlanReviewIdentitySchema, childPlanReviewKey, parseChildPlanReviewDescription } from "@pilleo/paperclip-adapter-common";
