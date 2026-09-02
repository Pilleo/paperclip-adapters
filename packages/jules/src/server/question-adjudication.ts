import { z } from "zod";

const AnswerSchema = z.object({
  kind: z.literal("ANSWER"),
  answer: z.string().trim().min(1),
}).strict();

const EscalateSchema = z.object({
  kind: z.literal("ESCALATE"),
  reason: z.string().trim().min(1),
}).strict();

export type QuestionAdjudication = z.infer<typeof AnswerSchema> | z.infer<typeof EscalateSchema>;

/**
 * The reviewer protocol is a typed JSON contract. We intentionally do not
 * infer intent from prose, headings, or regular expressions.
 */
export function parseQuestionAdjudication(body: string): QuestionAdjudication | null {
  try {
    return z.union([AnswerSchema, EscalateSchema]).parse(JSON.parse(body));
  } catch {
    return null;
  }
}
