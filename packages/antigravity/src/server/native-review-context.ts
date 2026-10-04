import { z } from "zod";

const MAX_NATIVE_WAKE_BYTES = 48 * 1024;
const Wake = z.object({ issue: z.object({ id: z.string().min(1) }).passthrough(),
  executionContinuation: z.unknown().optional() }).passthrough();

/** Prior model transcripts are audit history, never the native review assignment. */
export function boundNativeReviewWake(context: Record<string, unknown>, nativeReviewBound: boolean):
  { readonly context: Record<string, unknown>; readonly compacted: boolean } {
  if (!nativeReviewBound || context["paperclipWake"] == null ||
      Buffer.byteLength(JSON.stringify(context["paperclipWake"])) <= MAX_NATIVE_WAKE_BYTES) {
    return { context, compacted: false };
  }
  const wake = Wake.parse(context["paperclipWake"]);
  const issueId = context["issueId"] ?? context["taskId"];
  if (wake.issue.id !== issueId) throw new Error("Oversized native review wake has inconsistent issue scope");
  const { executionContinuation: _priorWake, ...retainedWake } = wake;
  const boundedWake = { ...retainedWake, truncated: true, fallbackFetchNeeded: true };
  if (Buffer.byteLength(JSON.stringify(boundedWake)) > MAX_NATIVE_WAKE_BYTES) {
    throw new Error("Native review wake still exceeds bounded transport after removing prior continuation history");
  }
  const { executionContinuation: _priorContext, ...retainedContext } = context;
  return { context: { ...retainedContext, paperclipWake: boundedWake }, compacted: true };
}
