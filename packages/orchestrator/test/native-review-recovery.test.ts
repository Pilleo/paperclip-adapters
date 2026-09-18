import { describe, expect, it, vi } from "vitest";
import { prepareAndWakeNativeReview, recoverNativeReviewCard, revalidateNativeReviewWake, selectNativeReviewWakeAnchor, wakeNativeReview, type NativeReviewRecoveryInput } from "../src/core/native-review-recovery.js";

const base: NativeReviewRecoveryInput = {
  agentId: "luna-1",
  issueId: "issue-1",
  interactionId: "card-1",
  wakeCommentId: "comment-1",
  reason: "Review the native card.",
};

describe("native review recovery", () => {
  it("suppresses a compatibility wake when the fresh card read is already answered", async () => {
    const listInteractions = vi.fn().mockResolvedValue([{ id: "card-1", status: "answered" }]);
    const listHeartbeatRuns = vi.fn().mockResolvedValue([]);

    await expect(revalidateNativeReviewWake({
      paperclip: { listInteractions, listHeartbeatRuns } as never,
      companyId: "company-1",
      agentId: "luna-1",
      issueId: "issue-1",
      interactionId: "card-1",
      nowMs: Date.parse("2026-09-15T18:02:00.000Z"),
      graceMs: 60_000,
    })).resolves.toEqual({ action: "answered" });

    expect(listInteractions).toHaveBeenCalledWith("issue-1");
    expect(listHeartbeatRuns).toHaveBeenCalledWith("company-1", "luna-1", 50);
  });

  it("reads the card after reviewer runs so the final state fences a concurrent verdict", async () => {
    const calls: string[] = [];
    const listHeartbeatRuns = vi.fn(async () => {
      calls.push("runs");
      return [];
    });
    const listInteractions = vi.fn(async () => {
      calls.push("card");
      return [{ id: "card-1", status: "answered" }];
    });

    await revalidateNativeReviewWake({
      paperclip: { listInteractions, listHeartbeatRuns } as never,
      companyId: "company-1",
      agentId: "luna-1",
      issueId: "issue-1",
      interactionId: "card-1",
      nowMs: Date.parse("2026-09-15T18:02:00.000Z"),
      graceMs: 60_000,
    });

    expect(calls).toEqual(["runs", "card"]);
  });

  it("selects the latest durable Jules-session comment as the compatibility wake anchor", () => {
    expect(selectNativeReviewWakeAnchor([
      { id: "other", body: "ordinary status" },
      { id: "old-session", body: "[Open Jules session](https://jules.google.com/session/old)" },
      { id: "current-session", body: "[Open Jules session](https://jules.google.com/session/current)" },
    ])).toBe("current-session");
  });

  it("wakes exactly the scoped card through the Paperclip client", async () => {
    const wakeup = vi.fn().mockResolvedValue({ ok: true, status: 202, text: "{}" });
    const prepareTransport = vi.fn(async () => {});
    const result = await wakeNativeReview({ paperclip: { wakeup } as never, ...base, prepareTransport });

    expect(result).toMatchObject({ ok: true });
    expect(prepareTransport).toHaveBeenCalledOnce();
    expect(prepareTransport.mock.invocationCallOrder[0]).toBeLessThan(wakeup.mock.invocationCallOrder[0]);
    expect(wakeup).toHaveBeenCalledOnce();
    expect(wakeup).toHaveBeenCalledWith("luna-1", "issue_commented", "issue-1", {
      reviewInteractionId: "card-1",
      forceFreshSession: true,
      wakeCommentId: "comment-1",
      source: "automation",
      triggerDetail: "system",
    });
  });

  it("dispatches the existing addressed card instead of changing issue ownership", async () => {
    const dispatchNativeReview = vi.fn(async () => ({ ok: true, status: 202, text: "{}" }));
    const patchIssue = vi.fn();
    const wakeup = vi.fn();
    const prepareTransport = vi.fn(async () => {});

    await expect(prepareAndWakeNativeReview({
      paperclip: { dispatchNativeReview, patchIssue, wakeup } as never,
      ...base,
      wakeCommentId: undefined,
      prepareTransport,
    })).resolves.toMatchObject({ ok: true });

    expect(prepareTransport).toHaveBeenCalledOnce();
    expect(prepareTransport.mock.invocationCallOrder[0]).toBeLessThan(dispatchNativeReview.mock.invocationCallOrder[0]);
    expect(dispatchNativeReview).toHaveBeenCalledWith("issue-1", "card-1", "native-review-recovery:v2:issue-1:card-1");
    expect(patchIssue).not.toHaveBeenCalled();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("uses a durable comment-backed wake when the host needs compatibility context", async () => {
    const dispatchNativeReview = vi.fn();
    const wakeup = vi.fn().mockResolvedValue({ ok: true, status: 202, text: "{}" });

    await expect(prepareAndWakeNativeReview({
      paperclip: { dispatchNativeReview, wakeup } as never,
      ...base,
    })).resolves.toMatchObject({ ok: true });

    expect(dispatchNativeReview).not.toHaveBeenCalled();
    expect(wakeup).toHaveBeenCalledWith("luna-1", "issue_commented", "issue-1", {
      reviewInteractionId: "card-1",
      forceFreshSession: true,
      wakeCommentId: "comment-1",
      source: "automation",
      triggerDetail: "system",
    });
  });

  it("keeps the explicit reason for an unanchored wake", async () => {
    const wakeup = vi.fn().mockResolvedValue({ ok: true, status: 202, text: "{}" });

    await expect(wakeNativeReview({
      paperclip: { wakeup } as never,
      ...base,
      wakeCommentId: undefined,
    })).resolves.toMatchObject({ ok: true });

    expect(wakeup).toHaveBeenCalledWith("luna-1", "Review the native card.", "issue-1", {
      reviewInteractionId: "card-1",
      forceFreshSession: true,
    });
  });

  it("loads the durable Jules-session anchor before recovering a pending card", async () => {
    const listComments = vi.fn().mockResolvedValue([
      { id: "ordinary", body: "ordinary status" },
      { id: "jules-session", body: "[Open Jules session](https://jules.google.com/session/current)" },
    ]);
    const wakeup = vi.fn().mockResolvedValue({ ok: true, status: 202, text: "{}" });

    await expect(recoverNativeReviewCard({
      paperclip: { listComments, wakeup } as never,
      agentId: "luna-1",
      issueId: "issue-1",
      interactionId: "card-1",
      reason: "Review the native card.",
    })).resolves.toMatchObject({ ok: true });

    expect(listComments).toHaveBeenCalledWith("issue-1");
    expect(wakeup).toHaveBeenCalledWith("luna-1", "issue_commented", "issue-1", expect.objectContaining({
      reviewInteractionId: "card-1",
      wakeCommentId: "jules-session",
    }));
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
