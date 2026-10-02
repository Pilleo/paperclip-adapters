import { z } from "zod";

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
