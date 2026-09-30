import type { StressTask } from "./stress-campaign-manifest.js";
import { evaluateStressProgress, type StressIssueEvidence, type StressProgress } from "./stress-campaign-progress.js";
import { z } from "zod";

export const PilotRecoveryAuthorizationSchema = z.object({
  version: z.literal(1), decision: z.literal("acknowledge_recovered_pilot"),
  runKey: z.string().min(1), projectId: z.string().min(1), reference: z.string().min(10),
  issues: z.array(z.object({ key: z.enum(["03", "04"]), id: z.string().min(1), providerSessionId: z.string().min(1),
    prUrl: z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/),
    headSha: z.string().regex(/^[a-f0-9]{40}$/i) }).strict()).length(2),
}).strict();

export interface PilotRecoveryAuthorization {
  readonly version: 1;
  readonly decision: "acknowledge_recovered_pilot";
  readonly runKey: string;
  readonly projectId: string;
  readonly reference: string;
  readonly issues: readonly { readonly key: string; readonly id: string; readonly providerSessionId: string;
    readonly prUrl: string; readonly headSha: string }[];
}

export function evaluateRecoveredPilot(input: {
  readonly tasks: readonly StressTask[]; readonly issues: readonly StressIssueEvidence[];
  readonly runKey: string; readonly projectId: string; readonly authorization: PilotRecoveryAuthorization;
}): StressProgress | { readonly kind: "recovered"; readonly reason: string; readonly authorizationReference: string } {
  const receipt = PilotRecoveryAuthorizationSchema.safeParse(input.authorization);
  if (input.tasks.length !== 2 || input.tasks[0]?.key !== "03" || input.tasks[1]?.key !== "04") {
    return { kind: "invalid", reason: "recovery_receipt_not_pilot_scoped" };
  }
  if (!receipt.success || receipt.data.runKey !== input.runKey || receipt.data.projectId !== input.projectId ||
      new Set(receipt.data.issues.map((issue) => issue.key)).size !== 2) {
    return { kind: "invalid", reason: "recovery_receipt_scope_mismatch" };
  }
  for (const bound of receipt.data.issues) {
    const issue = input.issues.find((candidate) => candidate.key === bound.key);
    if (!issue || issue.id !== bound.id || issue.providerSessionId !== bound.providerSessionId ||
        issue.product?.url !== bound.prUrl || issue.product.headSha !== bound.headSha) {
      return { kind: "invalid", reason: "recovery_receipt_identity_mismatch" };
    }
  }
  const strict = evaluateStressProgress(input.tasks, input.issues);
  if (strict.kind !== "invalid" || strict.reason !== "shared_03_04_interval_overlap") return strict;
  if (input.issues.some((issue) => issue.status !== "done" || issue.assigneeAgentId !== null || issue.executionRunId !== null)) {
    return { kind: "invalid", reason: "recovered_pilot_not_settled" };
  }
  // All native verdict, session, dependency and merge proofs were checked by
  // the strict evaluator before it reached its historical interval rule.
  return { kind: "recovered", reason: strict.reason, authorizationReference: receipt.data.reference };
}
