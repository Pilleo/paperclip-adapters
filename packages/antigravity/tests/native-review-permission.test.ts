import { describe, expect, it } from "vitest";
import type { AcpPermissionRequest } from "acpx/runtime";
import { nativeReviewPermission } from "../src/server/native-review-permission.js";

function request(title: string, kind: "other" | "edit" = "other"): AcpPermissionRequest {
  return { sessionId: "session", inferredKind: "other", raw: { sessionId: "session",
    options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }],
    toolCall: { toolCallId: "tool", title, kind } } };
}

describe("run-bound native review ACP permissions", () => {
  it.each(["get_current_native_review_assignment", "submit_native_review_verdict", "submit_jules_question_decision"])(
    "permits only the addressed native control-plane tool %s under read-only workspace policy", (name) => {
      expect(nativeReviewPermission(request(`paperclip_review_${name}`), "approve-reads", true))
        .toEqual({ outcome: "allow_once" });
    });
  it("does not widen an explicit deny-all policy or an ordinary worker's MCP access", () => {
    const tool = request("paperclip_review_submit_native_review_verdict");
    expect(nativeReviewPermission(tool, "deny-all", true)).toBeUndefined();
    expect(nativeReviewPermission(tool, "approve-reads", false)).toBeUndefined();
  });
  it.each(["write_file", "rm -rf checkout", "other_submit_native_review_verdict",
    "paperclip_review_submit_native_review_verdict_extra"])("does not authorize %s", (name) => {
      expect(nativeReviewPermission(request(name), "approve-reads", true)).toBeUndefined();
    });
  it("does not accept a repository edit masquerading as a native tool title", () => {
    expect(nativeReviewPermission(request("paperclip_review_submit_native_review_verdict", "edit"),
      "approve-reads", true)).toBeUndefined();
  });
  it("never turns a once-only native grant into an always-allow rule", () => {
    const tool = request("paperclip_review_submit_native_review_verdict");
    tool.raw.options = [{ optionId: "always", kind: "allow_always", name: "Allow always" }];
    expect(nativeReviewPermission(tool, "approve-reads", true)).toBeUndefined();
  });
});
