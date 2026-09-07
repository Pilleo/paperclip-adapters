import { describe, expect, it } from "vitest";
import {
  resolveNativeReviewCard,
  submitNativeReviewVerdictFromRuntime,
  submitNativeReviewVerdict,
  type NativeReviewCard,
} from "../src/core/native-review-submission.js";

const card = (patch: Partial<NativeReviewCard> = {}): NativeReviewCard => ({
  id: "card-1",
  kind: "request_item_verdicts",
  status: "pending",
  addresseeAgentId: "luna-1",
  payload: { items: [{ id: "plan", label: "Plan" }] },
  ...patch,
});

describe("native review submission protocol", () => {
  it.each([
    ["the one addressed pending card", [card()], "card-1"],
    ["a non-pull-request item without hard-coded ids", [card()], "plan"],
  ])("resolves %s", (_name, cards, expected) => {
    const result = resolveNativeReviewCard(cards, "luna-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.card.id === expected || result.item.id === expected).toBe(true);
  });

  it.each([
    ["no addressed card", [card({ addresseeAgentId: "terra-1" })], "no_owned_pending_card"],
    ["two addressed cards", [card(), card({ id: "card-2" })], "ambiguous_owned_pending_cards"],
    ["a completed card", [card({ status: "answered" })], "no_owned_pending_card"],
    ["a malformed card", [card({ payload: { items: [] } })], "malformed_review_card"],
  ])("fails closed for %s", (_name, cards, code) => {
    const result = resolveNativeReviewCard(cards, "luna-1");
    expect(result).toMatchObject({ ok: false, code });
  });

  it("submits the server-owned card and verifies the answered response", async () => {
    const calls: Array<{ url: string; body: unknown; headers: unknown }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers });
      return new Response(JSON.stringify({
        id: "card-1",
        kind: "request_item_verdicts",
        status: "answered",
        result: { items: [{ id: "plan", verdict: "approve" }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const result = await submitNativeReviewVerdict({
      apiBase: "http://paperclip.test",
      issueId: "issue-1",
      agentId: "luna-1",
      token: "run-token",
      runId: "run-1",
      cards: [card()],
      verdict: "approve",
      fetcher,
    });

    expect(result).toEqual({ ok: true, interactionId: "card-1", itemId: "plan", verdict: "approve" });
    expect(calls).toEqual([{
      url: "http://paperclip.test/api/issues/issue-1/interactions/card-1/verdicts",
      body: { verdicts: [{ id: "plan", verdict: "approve" }] },
      headers: {
        Authorization: "Bearer run-token",
        "Content-Type": "application/json",
        "X-Paperclip-Run-Id": "run-1",
      },
    }]);
  });

  it("requires a reason for rejection and never treats a failed response as success", async () => {
    const result = await submitNativeReviewVerdict({
      apiBase: "http://paperclip.test/",
      issueId: "issue-1",
      agentId: "luna-1",
      token: "run-token",
      cards: [card()],
      verdict: "reject",
      fetcher: async () => new Response("not found", { status: 404 }),
    });
    expect(result).toMatchObject({ ok: false, code: "rejection_reason_required" });

    const failed = await submitNativeReviewVerdict({
      apiBase: "http://paperclip.test/",
      issueId: "issue-1",
      agentId: "luna-1",
      token: "run-token",
      cards: [card()],
      verdict: "reject",
      reason: "The plan is incomplete.",
      fetcher: async () => new Response("not found", { status: 404 }),
    });
    expect(failed).toMatchObject({ ok: false, code: "submit_http_error", status: 404 });
  });

  it("discovers the server-owned card with the run identity before it submits", async () => {
    const calls: string[] = [];
    const result = await submitNativeReviewVerdictFromRuntime({
      apiBase: "http://paperclip.test/api",
      issueId: "issue-1",
      agentId: "luna-1",
      token: "run-token",
      verdict: "approve",
      fetcher: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(url)}`);
        if (!init?.method || init.method === "GET") {
          return new Response(JSON.stringify([card()]), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          id: "card-1",
          kind: "request_item_verdicts",
          status: "answered",
          result: { items: [{ id: "plan", verdict: "approve" }] },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    expect(result).toMatchObject({ ok: true, interactionId: "card-1", verdict: "approve" });
    expect(calls).toEqual([
      "GET http://paperclip.test/api/issues/issue-1/interactions",
      "POST http://paperclip.test/api/issues/issue-1/interactions/card-1/verdicts",
    ]);
  });

  it("allows loopback local-trusted runtime without a bearer token", async () => {
    const result = await submitNativeReviewVerdictFromRuntime({
      apiBase: "http://127.0.0.1:3100/api",
      issueId: "issue-1",
      agentId: "luna-1",
      runId: "run-1",
      verdict: "approve",
      fetcher: async (url, init) => {
        if (!init?.method || init.method === "GET") return new Response(JSON.stringify([card()]), { status: 200 });
        return new Response(JSON.stringify({
          id: "card-1", status: "answered", result: { items: [{ id: "plan", verdict: "approve" }] },
        }), { status: 200 });
      },
    });
    expect(result).toMatchObject({ ok: true, interactionId: "card-1", verdict: "approve" });
  });

  it("returns a typed transport failure when the control-plane request throws", async () => {
    const result = await submitNativeReviewVerdictFromRuntime({
      apiBase: "http://paperclip.test/api",
      issueId: "issue-1",
      agentId: "luna-1",
      token: "run-token",
      verdict: "approve",
      fetcher: async () => { throw new Error("socket closed"); },
    });

    expect(result).toEqual({ ok: false, code: "runtime_transport_error" });
  });
});
