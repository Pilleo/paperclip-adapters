import { createHash } from "node:crypto";
import { z } from "zod";

export const CHILD_PLAN_REVIEW_PREFIX = "<!-- paperclip-child-plan-review:v3\n";
export const ChildPlanReviewIdentitySchema = z.object({
  version: z.literal(3), companyId: z.string().min(1), parentIssueId: z.string().min(1),
  sessionId: z.string().min(1), activityId: z.string().min(1), documentId: z.string().min(1),
  revisionId: z.string().min(1), revisionNumber: z.number().int().positive(), stage: z.enum(["luna", "terra"]),
  reviewerAgentId: z.string().min(1), bootstrapAgentId: z.string().min(1), julesAgentId: z.string().min(1),
}).strict().refine((value) => new Set([value.reviewerAgentId, value.bootstrapAgentId, value.julesAgentId]).size === 3,
  "Jules, bootstrap and reviewer must be distinct principals");
export type ChildPlanReviewIdentity = z.infer<typeof ChildPlanReviewIdentitySchema>;

export function childPlanReviewKey(input: ChildPlanReviewIdentity): string {
  const identity = ChildPlanReviewIdentitySchema.parse(input);
  return `jules:plan-child:v3:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function childPlanReviewDescription(input: ChildPlanReviewIdentity): string {
  const identity = ChildPlanReviewIdentitySchema.parse(input);
  return `${CHILD_PLAN_REVIEW_PREFIX}${JSON.stringify(identity)}\n-->\n\nReview only the referenced parent plan revision. ` +
    "The addressed native plan card is the sole decision channel. The parent remains owned by Jules. " +
    "Do not reassign the parent, infer a verdict from comments, or submit a second decision for an answered card.";
}

export function parseChildPlanReviewDescription(description: unknown): ChildPlanReviewIdentity | null {
  if (typeof description !== "string" || !description.startsWith(CHILD_PLAN_REVIEW_PREFIX)) return null;
  const end = description.indexOf("\n-->", CHILD_PLAN_REVIEW_PREFIX.length);
  if (end < 0) return null;
  let raw: unknown;
  try { raw = JSON.parse(description.slice(CHILD_PLAN_REVIEW_PREFIX.length, end)); }
  catch { return null; }
  const parsed = ChildPlanReviewIdentitySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function isStablePlanReviewChild(value: unknown): boolean {
  const parsed = z.object({ companyId: z.string(), parentId: z.string(), createdByAgentId: z.string(), description: z.string() }).safeParse(value);
  if (!parsed.success) return false;
  const identity = parseChildPlanReviewDescription(parsed.data.description);
  return identity !== null && identity.companyId === parsed.data.companyId && identity.parentIssueId === parsed.data.parentId &&
    identity.julesAgentId === parsed.data.createdByAgentId;
}
