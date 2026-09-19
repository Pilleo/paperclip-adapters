import { z } from "zod";

declare const nativeReviewIssueIdBrand: unique symbol;

export type NativeReviewIssueId = string & {
  readonly [nativeReviewIssueIdBrand]: "NativeReviewIssueId";
};

const NativeReviewIssueIdSchema = z.string().trim().min(1)
  .transform((value) => value as NativeReviewIssueId);

const NativePlanReviewMigrationInputSchema = z.object({
  parentIssueId: NativeReviewIssueIdSchema,
  reviewIssueId: NativeReviewIssueIdSchema,
  sourceRunIssueId: NativeReviewIssueIdSchema.nullable(),
  status: z.enum(["pending", "answered"]),
  reviewerRunState: z.enum(["none", "active", "terminal"]),
}).readonly();

export interface NativePlanReviewMigrationInput {
  readonly parentIssueId: string;
  readonly reviewIssueId: string;
  readonly sourceRunIssueId: string | null;
  readonly status: "pending" | "answered";
  readonly reviewerRunState: "none" | "active" | "terminal";
}

export type NativePlanReviewLocation = "parent" | "legacy_child";

export type NativePlanReviewMigrationDecision =
  | { readonly action: "keep"; readonly location: NativePlanReviewLocation }
  | { readonly action: "await_active_run"; readonly location: "legacy_child" }
  | { readonly action: "migrate_to_parent"; readonly legacyReviewIssueId: NativeReviewIssueId; readonly targetIssueId: NativeReviewIssueId }
  | { readonly action: "consume_existing"; readonly location: NativePlanReviewLocation }
  | { readonly action: "fail_closed"; readonly reason: "invalid_provenance" | "missing_child_source_identity" | "unrelated_source_issue" };

export function decideNativePlanReviewMigration(
  input: NativePlanReviewMigrationInput,
): NativePlanReviewMigrationDecision {
  const parsed = NativePlanReviewMigrationInputSchema.safeParse(input);
  if (!parsed.success) return { action: "fail_closed", reason: "invalid_provenance" };

  const { parentIssueId, reviewIssueId, sourceRunIssueId, status, reviewerRunState } = parsed.data;
  const location: NativePlanReviewLocation = reviewIssueId === parentIssueId
    ? "parent"
    : "legacy_child";

  switch (status) {
    case "answered":
      return { action: "consume_existing", location };
    case "pending":
      switch (location) {
        case "parent":
          return sourceRunIssueId === null || sourceRunIssueId === parentIssueId
            ? { action: "keep", location }
            : { action: "fail_closed", reason: "unrelated_source_issue" };
        case "legacy_child":
          if (sourceRunIssueId === null) {
            return { action: "fail_closed", reason: "missing_child_source_identity" };
          }
          if (sourceRunIssueId === parentIssueId) {
            if (reviewerRunState === "active") {
              return { action: "await_active_run", location };
            }
            return { action: "migrate_to_parent", legacyReviewIssueId: reviewIssueId, targetIssueId: parentIssueId };
          }
          return sourceRunIssueId === reviewIssueId
            ? { action: "keep", location }
            : { action: "fail_closed", reason: "unrelated_source_issue" };
        default:
          return assertNever(location);
      }
    default:
      return assertNever(status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled native plan review provenance state: ${String(value)}`);
}
