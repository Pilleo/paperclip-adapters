import { z } from "zod";

export const MutationCheckpointStatusSchema = z.enum(["pending", "succeeded", "failed"]);
export type MutationCheckpointStatus = z.infer<typeof MutationCheckpointStatusSchema>;

export const MutationCheckpointSchema = z.object({
  version: z.literal(1),
  key: z.string().min(1),
  operation: z.string().min(1),
  issueId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  activityId: z.string().min(1).optional(),
  status: MutationCheckpointStatusSchema,
  updatedAt: z.string().datetime(),
  responseId: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});
export type MutationCheckpoint = z.infer<typeof MutationCheckpointSchema>;

export function beginMutation(input: {
  key: string;
  operation: string;
  issueId: string;
  sessionId?: string;
  activityId?: string;
  now?: string;
}): MutationCheckpoint {
  return MutationCheckpointSchema.parse({
    version: 1,
    key: input.key,
    operation: input.operation,
    issueId: input.issueId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.activityId ? { activityId: input.activityId } : {}),
    status: "pending",
    updatedAt: input.now ?? new Date().toISOString(),
  });
}

export function markMutationSucceeded(
  checkpoint: MutationCheckpoint,
  input: { responseId?: string; now?: string } = {},
): MutationCheckpoint {
  return MutationCheckpointSchema.parse({
    ...checkpoint,
    status: "succeeded",
    updatedAt: input.now ?? new Date().toISOString(),
    ...(input.responseId ? { responseId: input.responseId } : {}),
    error: undefined,
  });
}

export function markMutationFailed(
  checkpoint: MutationCheckpoint,
  error: string,
  now = new Date().toISOString(),
): MutationCheckpoint {
  return MutationCheckpointSchema.parse({
    ...checkpoint,
    status: "failed",
    updatedAt: now,
    error: error.trim() || "Mutation failed",
  });
}

export function shouldResumeMutation(checkpoint: MutationCheckpoint | undefined): boolean {
  return checkpoint?.status === "pending" || checkpoint?.status === "failed";
}

