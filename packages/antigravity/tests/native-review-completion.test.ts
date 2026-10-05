import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { readNativeReviewScope, verifyNativeReviewCompletion } from "../src/server/native-review-completion.js";

const ctx = { runId: "run", authToken: "token", agent: { id: "reviewer", companyId: "company" }, context: { issueId: "child" } } as AdapterExecutionContext;
const card = { id: "card", companyId: "company", issueId: "child", addresseeAgentId: "reviewer", kind: "request_item_verdicts",
  status: "answered", resolvedByRunId: "run", payload: { items: [{ id: "pull_request" }] },
  result: { outcome: "resolved", complete: true, items: [{ id: "pull_request", verdict: "approve" }] } };
const identity = { version: 2, creatorPrincipal: "board", companyId: "company", parentIssueId: "parent", prUrl: "https://github.com/owner/repo/pull/1",
  headSha: "a".repeat(40), stage: "strong", reviewerAgentId: "reviewer", bootstrapAgentId: "orchestrator" };
const description = `<!-- paperclip-pr-review-child:v2\n${JSON.stringify(identity)}\n-->`;
const recordedCard = { ...card, resolvedByRunId: "prior-run", idempotencyKey: `pr-review:v13:child:${identity.prUrl}:${identity.headSha}:strong`,
  payload: { ...card.payload, detailsMarkdown: `**PR:** ${identity.prUrl}` } };
afterEach(() => vi.unstubAllGlobals());
const activeRun = { id: "run", companyId: "company", agentId: "reviewer", status: "running", contextSnapshot: { issueId: "child" } };

describe("authoritative native review completion", () => {
  it("accepts only the exact addressed structured verdict and physical resolver run", async () => {
    const scope = { kind: "pending" as const, cardId: "card", cardKind: "request_item_verdicts", itemId: "pull_request" };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify([card])));
    expect(await verifyNativeReviewCompletion(ctx, scope)).toBe(true);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify([{ ...card, resolvedByRunId: "another-run" }])));
    expect(await verifyNativeReviewCompletion(ctx, scope)).toBe(false);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify([{ ...card, result: { summary: "approve" } }])));
    expect(await verifyNativeReviewCompletion(ctx, scope)).toBe(false);
  });

  it("does not start another provider for a proved prior verdict on a native child", async () => {
    vi.stubGlobal("fetch", async input => new Response(JSON.stringify(String(input).endsWith('/heartbeat-runs/run') ? activeRun : String(input).endsWith('/interactions') ? [recordedCard]
      : String(input).includes('/heartbeat-runs/') ? { id: "prior-run", companyId: "company", agentId: "reviewer", status: "succeeded", contextSnapshot: { issueId: "child" } }
      : { id: "child", companyId: "company", description })));
    expect(await readNativeReviewScope(ctx)).toMatchObject({ kind: "recorded", cardId: "card" });
  });

  it("refuses a claimed recorded native child without a typed result", async () => {
    vi.stubGlobal("fetch", async input => new Response(JSON.stringify(String(input).endsWith('/heartbeat-runs/run') ? activeRun : String(input).endsWith('/interactions') ? [{ ...recordedCard, result: null }]
      : { id: "child", companyId: "company", description })));
    await expect(readNativeReviewScope(ctx)).rejects.toThrow(/verdict|recorded/i);
  });

  it("does not mistake old answered review history on an ordinary task for completed coding work", async () => {
    vi.stubGlobal("fetch", async input => new Response(JSON.stringify(String(input).endsWith('/heartbeat-runs/run') ? activeRun : String(input).endsWith('/interactions') ? [card]
      : { id: "child", companyId: "company", description: 'Implement the next change' })));
    expect(await readNativeReviewScope(ctx)).toEqual({ kind: "ordinary" });
  });

  it("does not accept a succeeded prior verdict for another immutable target named by the helper", async () => {
    const identity = { version: 2, creatorPrincipal: "board", companyId: "company", parentIssueId: "parent", prUrl: "https://github.com/owner/repo/pull/1",
      headSha: "b".repeat(40), stage: "strong", reviewerAgentId: "reviewer", bootstrapAgentId: "orchestrator" };
    const stale = { ...recordedCard, idempotencyKey: `pr-review:v13:child:${identity.prUrl}:${"a".repeat(40)}:strong` };
    vi.stubGlobal("fetch", async input => new Response(JSON.stringify(String(input).endsWith('/heartbeat-runs/run') ? activeRun : String(input).endsWith('/interactions') ? [stale]
      : String(input).includes('/heartbeat-runs/') ? { id: "run", companyId: "company", agentId: "reviewer", status: "succeeded", contextSnapshot: { issueId: "child" } }
      : { id: "child", companyId: "company", description: `<!-- paperclip-pr-review-child:v2\n${JSON.stringify(identity)}\n-->` })));
    await expect(readNativeReviewScope(ctx)).rejects.toThrow(/target|recorded/i);
  });

  it("does not classify an unassigned native helper as ordinary successful coding work", async () => {
    vi.stubGlobal("fetch", async input => new Response(JSON.stringify(String(input).includes('/heartbeat-runs/') ? activeRun
      : String(input).endsWith('/interactions') ? [] : { id: "child", companyId: "company", description })));
    await expect(readNativeReviewScope(ctx)).rejects.toThrow(/target|assignment/i);
  });

  it("does not demand a native verdict during an authoritative status-only followup", async () => {
    vi.stubGlobal("fetch", async input => new Response(JSON.stringify(String(input).includes('/heartbeat-runs/')
      ? { ...activeRun, contextSnapshot: { issueId: "child", wakeReason: "issue_continuation_needed", recoveryIntent: "status_only",
        allowDeliverableWork: false, allowDocumentUpdates: false, resumeRequiresNormalModel: true } }
      : [{ ...card, status: "pending" }])));
    expect(await readNativeReviewScope(ctx)).toMatchObject({ kind: "status_only" });
  });
});
