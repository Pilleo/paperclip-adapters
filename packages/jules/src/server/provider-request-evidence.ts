import { createHash, randomUUID } from "node:crypto";
import type { CreateSessionRequest } from "./jules-client.js";

/** Allowlisted provider write intent; neither credentials nor prompt text are persisted. */
export type ProviderRequestEvidence =
  | { readonly kind: "create"; readonly requestId: string; readonly issueId: string; readonly runId: string;
      readonly requirePlanApproval: boolean; readonly approvalFlagPresent: boolean; readonly automationMode: string;
      readonly source: string; readonly baseBranch: string; readonly promptSha256: string }
  | { readonly kind: "mutation"; readonly requestId: string; readonly sessionId: string;
      readonly method: "approve_plan" | "request_revision" | "send_message";
      readonly effectId: string; readonly planActivityId: string | null };

export function createProviderCreateEvidence(
  request: CreateSessionRequest,
  scope: { readonly issueId: string; readonly runId: string },
  requestId: string = randomUUID(),
): Extract<ProviderRequestEvidence, { kind: "create" }> {
  if (!scope.issueId.trim() || !scope.runId.trim()) throw new Error("Provider creation requires issue and run attribution");
  return {
    kind: "create", requestId, issueId: scope.issueId, runId: scope.runId,
    requirePlanApproval: request.requirePlanApproval === true,
    approvalFlagPresent: Object.hasOwn(request, "requirePlanApproval"),
    automationMode: request.automationMode ?? "AUTOMATION_MODE_UNSPECIFIED",
    source: request.sourceContext.source,
    baseBranch: request.sourceContext.githubRepoContext?.startingBranch ?? "",
    promptSha256: createHash("sha256").update(request.prompt).digest("hex"),
  };
}

export function createProviderMutationEvidence(input: {
  readonly sessionId: string;
  readonly method: "approve_plan" | "request_revision" | "send_message";
  readonly effectId: string;
  readonly planActivityId?: string | null | undefined;
}): Extract<ProviderRequestEvidence, { kind: "mutation" }> {
  if (!input.sessionId.trim() || !input.effectId.trim()) throw new Error("Provider mutation requires an attributable effect identity");
  return { kind: "mutation", requestId: randomUUID(), sessionId: input.sessionId,
    method: input.method, effectId: input.effectId, planActivityId: input.planActivityId ?? null };
}
