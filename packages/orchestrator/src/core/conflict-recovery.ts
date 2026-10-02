import { z } from "zod";
import { createHash } from "node:crypto";
import { asArray, type PaperclipHttp } from "./paperclip-http.js";
import { evaluatePrMergeability, type PrMergeabilityInfo } from "./git-safety.js";

export type ConflictRecoveryPolicy =
  | { readonly mode: "manual" }
  | { readonly mode: "git_only" }
  | { readonly mode: "agent"; readonly agentId: string };

export const conflictRecoveryConfigFields = {
  conflictRecoveryMode: z.enum(["manual", "git_only", "agent"]).default("manual"),
  conflictRecoveryAgentId: z.string().trim().min(1).optional(),
};

export function refineConflictRecoverySelection(
  config: { conflictRecoveryMode: string; conflictRecoveryAgentId?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (config.conflictRecoveryMode === "agent" && !config.conflictRecoveryAgentId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["conflictRecoveryAgentId"],
      message: "Agent conflict recovery requires an explicitly configured agent ID" });
  }
}

const PolicyConfig = z.object(conflictRecoveryConfigFields).superRefine(refineConflictRecoverySelection);

export function normalizeConflictRecoveryPolicy(raw: unknown): ConflictRecoveryPolicy {
  const config = PolicyConfig.parse(raw);
  if (config.conflictRecoveryMode === "agent") {
    return { mode: "agent", agentId: config.conflictRecoveryAgentId! };
  }
  return { mode: config.conflictRecoveryMode };
}

/** Explicit company selection, deliberately independent of managed roles and adapters. */
export function selectConflictRecoveryAgent<T extends { readonly id: string; readonly companyId: string }>(
  companyId: string, agentId: string, agents: readonly T[],
): T {
  const matches = agents.filter((agent) => agent.id === agentId && agent.companyId === companyId);
  if (matches.length !== 1) throw new Error(`Conflict resolver ${agentId} is not a unique agent in company ${companyId}`);
  return matches[0]!;
}

const sha = z.string().regex(/^[0-9a-f]{40}$/i);
export const ConflictRecoveryStateSchema = z.object({
  version: z.literal(1), attemptId: z.string().min(1), companyId: z.string().min(1),
  projectId: z.string().min(1), issueId: z.string().min(1), productId: z.string().min(1),
  prUrl: z.string().url(), headRef: z.string().min(1), baseRef: z.string().min(1),
  previousHeadSha: sha, reviewHeadSha: sha, baseSha: sha.nullable(),
  phase: z.enum(["waiting", "dispatch_intent", "dispatched", "integrating", "resolved", "failed"]),
  agentId: z.string().min(1).nullable(), repairTaskId: z.string().min(1).nullable(),
  repairRunId: z.string().min(1).nullable(), resolvedHeadSha: sha.nullable(),
  cardRequested: z.boolean(), cardId: z.string().min(1).nullable(),
});
export type ConflictRecoveryState = z.infer<typeof ConflictRecoveryStateSchema>;
export const CONFLICT_REPAIR_PREFIX = "<!-- paperclip-conflict-repair:v1\n";

export function conflictRepairDescription(state: ConflictRecoveryState): string {
  return `${CONFLICT_REPAIR_PREFIX}${JSON.stringify(state)}\n-->\n\n` +
    `Resolve conflicts on the existing PR ${state.prUrl}, branch ${state.headRef}, against ${state.baseRef}. ` +
    `Expected original head: ${state.previousHeadSha}. Preserve both sides' intended changes and run relevant verification. ` +
    "Use an isolated workspace for local Git operations. Publish the resolved head on this same PR branch. " +
    "Do not create a replacement PR or merge the PR. Report the resulting immutable head. Existing PR reviews must be preserved.";
}

export function parseConflictRepairDescription(description: unknown): ConflictRecoveryState | null {
  if (typeof description !== "string" || !description.startsWith(CONFLICT_REPAIR_PREFIX)) return null;
  const end = description.indexOf("\n-->", CONFLICT_REPAIR_PREFIX.length);
  if (end < 0) return null;
  try {
    const result = ConflictRecoveryStateSchema.safeParse(JSON.parse(description.slice(CONFLICT_REPAIR_PREFIX.length, end)));
    return result.success ? result.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export interface ConflictRecoveryInput {
  readonly client: PaperclipHttp;
  readonly policy: ConflictRecoveryPolicy;
  readonly companyId: string;
  readonly projectId: string;
  readonly issueId: string;
  readonly productId: string;
  readonly prUrl: string;
  readonly headSha: string;
  readonly mergeability: PrMergeabilityInfo;
}
export type ConflictRecoveryDisposition =
  | { readonly kind: "clear"; readonly state?: ConflictRecoveryState }
  | { readonly kind: "waiting"; readonly reason: string };

const recoveryLocks = new Map<string, Promise<void>>();

/** Serializes one source's effects; persisted native receipts survive process restart. */
export async function reconcileConflictRecovery(input: ConflictRecoveryInput): Promise<ConflictRecoveryDisposition> {
  const key = `${input.companyId}:${input.productId}`;
  const previous = recoveryLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  recoveryLocks.set(key, held);
  await previous;
  try { return await reconcileOwnedConflictRecovery(input); }
  finally { release(); if (recoveryLocks.get(key) === held) recoveryLocks.delete(key); }
}

async function reconcileOwnedConflictRecovery(input: ConflictRecoveryInput): Promise<ConflictRecoveryDisposition> {
  const { client, policy } = input;
  const products = asArray<Record<string, unknown>>(await client.getJson(`/api/issues/${encodeURIComponent(input.issueId)}/work-products`));
  const matching = products.filter((item) => item["id"] === input.productId && item["url"] === input.prUrl &&
    item["type"] === "pull_request" && item["isPrimary"] === true);
  if (matching.length !== 1) throw new Error("Conflict recovery requires the existing unique primary PR product");
  const product = matching[0]!;
  const metadata = z.record(z.unknown()).parse(product["metadata"] ?? {});
  let state = metadata["conflictRecovery"] == null ? null : ConflictRecoveryStateSchema.parse(metadata["conflictRecovery"]);
  if (state && (state.companyId !== input.companyId || state.issueId !== input.issueId ||
    state.productId !== input.productId || state.projectId !== input.projectId || state.prUrl !== input.prUrl)) {
    throw new Error("Conflict recovery identity changed");
  }
  const safety = evaluatePrMergeability(input.mergeability);
  const needsRecovery = safety.isConflicting || input.mergeability.mergeStateStatus === "BEHIND";
  if (!needsRecovery) return { kind: "clear", ...(state ? { state } : {}) };
  if (!/^[0-9a-f]{40}$/i.test(input.headSha) || !input.mergeability.headRefName || !input.mergeability.baseRefName) {
    return { kind: "waiting", reason: "Immutable PR head or branch identity unavailable" };
  }
  const persist = async (next: ConflictRecoveryState): Promise<void> => {
    const response = await client.patchWorkProduct(input.productId, { metadata: { ...metadata, conflictRecovery: next } });
    if (!response.ok) throw new Error(`Could not persist conflict recovery (${response.status}): ${response.text}`);
    state = next;
    metadata["conflictRecovery"] = next;
  };
  if (!state || (state.phase === "resolved" && state.resolvedHeadSha === input.headSha)) {
    const reviewHeadSha = state?.reviewHeadSha ?? input.headSha;
    const attemptId = createHash("sha256").update(JSON.stringify([
      input.companyId, input.issueId, input.productId, input.prUrl, input.headSha,
      input.mergeability.baseRefOid ?? input.mergeability.baseRefName,
    ])).digest("hex");
    state = { version: 1, attemptId, companyId: input.companyId, projectId: input.projectId,
      issueId: input.issueId, productId: input.productId, prUrl: input.prUrl,
      headRef: input.mergeability.headRefName, baseRef: input.mergeability.baseRefName,
      previousHeadSha: input.headSha, reviewHeadSha, baseSha: input.mergeability.baseRefOid ?? null,
      phase: "waiting", agentId: null, repairTaskId: null, repairRunId: null,
      resolvedHeadSha: null, cardRequested: false, cardId: null };
    await persist(state);
  }

  const waitForOperator = async (reason: string): Promise<ConflictRecoveryDisposition> => {
    const cards = asArray<Record<string, unknown>>(await client.listApprovals(input.companyId));
    const found = cards.filter((card) => (card["payload"] as Record<string, unknown> | undefined)?.["conflictAttemptId"] === state!.attemptId);
    if (found.length > 1) throw new Error("Ambiguous native conflict resolution cards");
    if (found[0]) {
      if (state!.cardId !== found[0]["id"]) await persist({ ...state!, cardId: String(found[0]["id"]) });
    } else if (!state!.cardRequested) {
      await persist({ ...state!, cardRequested: true });
      const created = await client.createApproval(input.companyId, { type: "request_board_approval",
        title: `Resolve conflict on ${input.prUrl}`, issueIds: [input.issueId],
        description: `${reason}. Resolve the existing PR externally or configure explicit agent recovery. Acknowledgement does not start AI, resolve Git, or merge the PR.`,
        payload: { action: "conflict_resolution", issueId: input.issueId, prUrl: input.prUrl,
          headSha: state!.previousHeadSha, conflictAttemptId: state!.attemptId } });
      if (!created.ok) throw new Error(`Native conflict card failed (${created.status}): ${created.text}`);
      const id = (created.data as Record<string, unknown> | undefined)?.["id"];
      if (typeof id !== "string") throw new Error("Native conflict card receipt has no identity");
      await persist({ ...state!, cardId: id });
      const preserved = await client.patchIssue(input.issueId, { status: "in_review", assigneeAgentId: null,
        executionPolicy: null, executionState: null });
      if (!preserved.ok) throw new Error("Could not preserve the manual conflict wait");
    }
    return { kind: "waiting", reason };
  };
  if (policy.mode === "manual") return waitForOperator("Manual conflict recovery");
  if (policy.mode === "git_only") return waitForOperator("Clean integration requires an isolated recovery operation");

  const selected = z.object({ id: z.string(), companyId: z.string(), adapterType: z.string(), status: z.string() })
    .parse(await client.getJson(`/api/agents/${encodeURIComponent(policy.agentId)}`));
  selectConflictRecoveryAgent(input.companyId, policy.agentId, [selected]);
  if (["paused", "error", "terminated"].includes(selected.status)) {
    return { kind: "waiting", reason: `Configured resolver ${selected.id} is ${selected.status}` };
  }
  const children = asArray<Record<string, unknown>>(await client.listChildren(input.companyId, input.issueId));
  if (children.length >= 1000) throw new Error("Conflict repair task inventory is incomplete");
  const matches = children.filter((child) => parseConflictRepairDescription(child["description"])?.attemptId === state!.attemptId);
  if (matches.length > 1) throw new Error("Duplicate native conflict repair tasks");
  const existing = matches[0];
  if (existing) {
    const assigned = parseConflictRepairDescription(existing["description"])!;
    if (existing["companyId"] !== input.companyId || existing["parentId"] !== input.issueId ||
      existing["assigneeAgentId"] !== assigned.agentId || assigned.agentId !== state.agentId) {
      throw new Error("Conflict repair task ownership changed");
    }
    if (!state.repairTaskId) await persist({ ...state, phase: "dispatched", repairTaskId: String(existing["id"]) });
    return { kind: "waiting", reason: `Native repair task ${existing["id"]} owns this attempt` };
  }
  if (state.phase !== "waiting") return { kind: "waiting", reason: "Repair admission outcome is unresolved; observing without replay" };
  await persist({ ...state, phase: "dispatch_intent", agentId: selected.id });
  const created = await client.createChildIssue(input.issueId, {
    title: "Resolve existing PR conflicts", description: conflictRepairDescription(state!),
    status: "todo", assigneeAgentId: selected.id, projectId: input.projectId, blockParentUntilDone: false,
    executionPolicy: { mode: "normal", stages: [], commentRequired: false },
  });
  if (!created.ok) throw new Error(`Native conflict task admission failed (${created.status}): ${created.text}`);
  const child = z.object({ id: z.string(), companyId: z.string(), parentId: z.string(), assigneeAgentId: z.string() }).parse(created.data);
  if (child.companyId !== input.companyId || child.parentId !== input.issueId || child.assigneeAgentId !== selected.id) {
    throw new Error("Conflict repair admission receipt changed identity");
  }
  await persist({ ...state!, phase: "dispatched", repairTaskId: child.id });
  return { kind: "waiting", reason: `Native repair task ${child.id} admitted to configured resolver ${selected.id}` };
}
