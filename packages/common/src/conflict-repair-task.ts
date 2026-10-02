import { z } from "zod";

export const CONFLICT_REPAIR_TASK_PREFIX = "<!-- paperclip-conflict-repair:v1\n";
const Assignment = z.object({ version: z.literal(1), attemptId: z.string().min(1), companyId: z.string().min(1),
  issueId: z.string().min(1), agentId: z.string().min(1), headRef: z.string().min(1), baseRef: z.string().min(1),
  prUrl: z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/) });

export function parseConflictRepairTask(description: string): z.infer<typeof Assignment> | null {
  if (!description.startsWith(CONFLICT_REPAIR_TASK_PREFIX)) return null;
  const end = description.indexOf("\n-->", CONFLICT_REPAIR_TASK_PREFIX.length);
  if (end < 0) throw new Error("Conflict repair assignment is incomplete");
  return Assignment.parse(JSON.parse(description.slice(CONFLICT_REPAIR_TASK_PREFIX.length, end)));
}
