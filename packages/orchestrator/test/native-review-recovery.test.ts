import { describe, expect, it, vi } from "vitest";
import { prepareAndWakeNativeReview, revalidateNativeReviewWake, type NativeReviewRecoveryInput } from "../src/core/native-review-recovery.js";

const base: NativeReviewRecoveryInput = {
  agentId: "luna-1",
  issueId: "issue-1",
  interactionId: "card-1",
  reason: "Review the native card.",
};

describe("native review recovery", () => {
  it("suppresses a reconciliation when the fresh card read is already answered", async () => {
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
  });

  it("suppresses a same-card wake when fresh evidence now contains a terminal reviewer run", async () => {
    const listInteractions = vi.fn().mockResolvedValue([{ id: "card-1", status: "pending", createdAt: "2026-09-15T18:00:00.000Z" }]);
    const listHeartbeatRuns = vi.fn().mockResolvedValue([{
      id: "run-1", agentId: "luna-1", status: "failed",
      contextSnapshot: { issueId: "issue-1", interactionId: "card-1" },
    }]);
    await expect(revalidateNativeReviewWake({
      paperclip: { listInteractions, listHeartbeatRuns } as never,
      companyId: "company-1", agentId: "luna-1", issueId: "issue-1", interactionId: "card-1",
      nowMs: Date.parse("2026-09-15T18:02:00.000Z"), graceMs: 60_000,
    })).resolves.toEqual({ action: "no_action" });
  });

  it("fails closed when a fresh card no longer has the immutable review identity", async () => {
    const listInteractions = vi.fn().mockResolvedValue([{
      id: "card-1",
      status: "pending",
      createdAt: "2026-09-15T18:00:00.000Z",
      idempotencyKey: "pr-review:other-head:luna",
      addresseeAgentId: "luna-1",
    }]);
    const listHeartbeatRuns = vi.fn().mockResolvedValue([]);

    await expect(revalidateNativeReviewWake({
      paperclip: { listInteractions, listHeartbeatRuns } as never,
      companyId: "company-1",
      agentId: "luna-1",
      issueId: "issue-1",
      interactionId: "card-1",
      immutableKey: "pr-review:current-head:luna",
      nowMs: Date.parse("2026-09-15T18:02:00.000Z"),
      graceMs: 60_000,
    })).resolves.toEqual({ action: "protocol_failure", reason: "card_identity_mismatch" });
  });

  it("observes a host-owned card without creating any adapter dispatch", async () => {
    const reconcileNativeReviewDispatch = vi.fn();
    const dispatchNativeReview = vi.fn();
    const wakeup = vi.fn();
    const prepareTransport = vi.fn(async () => {});

    await expect(prepareAndWakeNativeReview({
      paperclip: { reconcileNativeReviewDispatch, dispatchNativeReview, wakeup } as never,
      ...base,
      prepareTransport,
    })).resolves.toMatchObject({ ok: true });

    expect(prepareTransport).not.toHaveBeenCalled();
    expect(reconcileNativeReviewDispatch).not.toHaveBeenCalled();
    expect(dispatchNativeReview).not.toHaveBeenCalled();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it.each([
    ["agentId", { agentId: "" }],
    ["issueId", { issueId: "" }],
    ["interactionId", { interactionId: "" }],
  ])("rejects missing %s without making a request", async (_name, override) => {
    const reconcileNativeReviewDispatch = vi.fn();
    const dispatchNativeReview = vi.fn();
    const result = await prepareAndWakeNativeReview({
      paperclip: { reconcileNativeReviewDispatch, dispatchNativeReview } as never,
      ...base,
      ...override,
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: "invalid_native_review_identity" });
    expect(reconcileNativeReviewDispatch).not.toHaveBeenCalled();
    expect(dispatchNativeReview).not.toHaveBeenCalled();
  });
});
