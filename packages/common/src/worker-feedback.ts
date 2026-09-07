import { z } from "zod";

/** Structured feedback delivered from a native reviewer to the delegated worker. */
export const WorkerFeedbackEnvelopeSchema = z.object({
  version: z.literal(1),
  kind: z.literal("code_review_rejection"),
  deliveryId: z.string().min(1),
  issueId: z.string().min(1),
  reviewInteractionId: z.string().min(1),
  reviewStage: z.enum(["vibe", "luna", "terra", "strong", "operator_approval"]),
  prUrl: z.string().url(),
  headSha: z.string().min(1),
  reason: z.string().min(1),
  createdAt: z.string().datetime(),
});

export type WorkerFeedbackEnvelope = z.infer<typeof WorkerFeedbackEnvelopeSchema>;

export function parseWorkerFeedback(value: unknown): WorkerFeedbackEnvelope | null {
  const parsed = WorkerFeedbackEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function workerFeedbackPrompt(feedback: WorkerFeedbackEnvelope): string {
  return [
    "A native Paperclip code review requested changes to your pull request.",
    `Review stage: ${feedback.reviewStage}`,
    `Pull request: ${feedback.prUrl}`,
    `Reviewed commit: ${feedback.headSha}`,
    "Apply the requested changes in the existing scoped checkout, run the declared tests, and update the pull request.",
    `Concrete feedback: ${feedback.reason}`,
  ].join("\n");
}
