import { describe, expect, it, vi } from "vitest";
import { prepareAndWakeNativeReview, wakeNativeReview, type NativeReviewRecoveryInput } from "../src/core/native-review-recovery.js";

const base: NativeReviewRecoveryInput = {
  agentId: "luna-1",
  issueId: "issue-1",
  interactionId: "card-1",
  reason: "Review the native card.",
};

describe("native review recovery", () => {
  it("wakes exactly the scoped card through the Paperclip client", async () => {
    const wakeup = vi.fn().mockResolvedValue({ ok: true, status: 202, text: "{}" });
    const result = await wakeNativeReview({ paperclip: { wakeup } as never, ...base });

    expect(result).toMatchObject({ ok: true });
    expect(wakeup).toHaveBeenCalledOnce();
    expect(wakeup).toHaveBeenCalledWith("luna-1", "Review the native card.", "issue-1", {
      reviewInteractionId: "card-1",
      forceFreshSession: true,
    });
  });

  it("assigns the addressed reviewer before waking a card-bound recovery", async () => {
    const calls: string[] = [];
    const patchIssue = vi.fn(async () => { calls.push("patch"); return { ok: true, status: 200, text: "{}" }; });
    const wakeup = vi.fn(async () => { calls.push("wake"); return { ok: true, status: 202, text: "{}" }; });

    await expect(prepareAndWakeNativeReview({ paperclip: { patchIssue, wakeup } as never, ...base })).resolves.toMatchObject({ ok: true });

    expect(calls).toEqual(["patch", "wake"]);
    expect(patchIssue).toHaveBeenCalledWith("issue-1", { status: "in_review", assigneeAgentId: "luna-1" });
  });

  it.each([
    ["agentId", { agentId: "" }],
    ["issueId", { issueId: "" }],
    ["interactionId", { interactionId: "" }],
  ])("rejects missing %s without making a request", async (_name, override) => {
    const wakeup = vi.fn();
    const result = await wakeNativeReview({ paperclip: { wakeup } as never, ...base, ...override });

    expect(result).toMatchObject({ ok: false, status: 400, code: "invalid_native_review_identity" });
    expect(wakeup).not.toHaveBeenCalled();
  });
});
