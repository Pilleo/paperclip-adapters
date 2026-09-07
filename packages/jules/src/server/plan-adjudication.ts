import { z } from "zod";

const PassSchema = z.object({ kind: z.literal("PASS_TO_STRONG"), summary: z.string().trim().min(1) }).strict();
const ApproveSchema = z.object({ kind: z.literal("APPROVE"), summary: z.string().trim().min(1) }).strict();
const ReviseSchema = z.object({
  kind: z.literal("REQUEST_REVISION"),
  findings: z.array(z.string().trim().min(1)).min(1),
  questions: z.array(z.string().trim().min(1)).default([]),
}).strict();
const EscalateSchema = z.object({ kind: z.literal("ESCALATE"), reason: z.string().trim().min(1) }).strict();

export type PlanAdjudication = z.infer<typeof PassSchema> | z.infer<typeof ApproveSchema> |
  z.infer<typeof ReviseSchema> | z.infer<typeof EscalateSchema>;

/** Strict ACP contract. Prose is never interpreted as a verdict. */
export function parsePlanAdjudication(body: string): PlanAdjudication | null {
  try { return z.union([PassSchema, ApproveSchema, ReviseSchema, EscalateSchema]).parse(JSON.parse(body)); }
  catch { return null; }
}
