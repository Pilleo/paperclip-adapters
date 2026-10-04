import type { AcpPermissionDecision, AcpPermissionRequest } from "acpx/runtime";

export const NATIVE_REVIEW_TOOL_NAMES = [
  "paperclip_review_get_current_native_review_assignment",
  "paperclip_review_submit_native_review_verdict",
  "paperclip_review_submit_jules_question_decision",
] as const;

/** The run-scoped MCP enforces addressed-card authority; repository writes keep the normal ACP policy. */
export function nativeReviewPermission(request: AcpPermissionRequest,
  permissionMode: "approve-all" | "approve-reads" | "deny-all",
  nativeReviewBound: boolean): AcpPermissionDecision | undefined {
  if (!nativeReviewBound || permissionMode !== "approve-reads" ||
      request.raw.toolCall.kind !== "other" || !NATIVE_REVIEW_TOOL_NAMES.some(name => name === request.raw.toolCall.title) ||
      !request.raw.options.some(option => option.kind === "allow_once")) {
    return undefined;
  }
  return { outcome: "allow_once" };
}
