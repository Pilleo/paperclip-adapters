import { ConflictRecoveryStateSchema } from "./conflict-recovery.js";

/** Preserve review evidence's original head only for this recorded resolved repair. */
export function reviewHeadAfterConflictResolution(metadata: Record<string, unknown> | null | undefined, identity: {
  readonly companyId: string; readonly issueId: string; readonly prUrl: string; readonly currentHeadSha: string;
}): string {
  if (metadata?.["conflictRecovery"] == null) return identity.currentHeadSha;
  const repair = ConflictRecoveryStateSchema.parse(metadata["conflictRecovery"]);
  if (repair.phase !== "resolved" || repair.resolvedHeadSha !== identity.currentHeadSha) return identity.currentHeadSha;
  if (repair.companyId !== identity.companyId || repair.issueId !== identity.issueId || repair.prUrl !== identity.prUrl ||
    metadata["headSha"] !== identity.currentHeadSha || (repair.agentId && (!repair.repairTaskId || !repair.repairRunId))) {
    throw new Error("Conflict review continuity has mismatched identity or incomplete repair provenance");
  }
  return repair.reviewHeadSha;
}
