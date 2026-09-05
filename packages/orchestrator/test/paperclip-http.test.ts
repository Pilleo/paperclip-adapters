import { describe, it, expect, vi, afterEach } from "vitest";
import { createPaperclipHttp } from "../src/core/paperclip-http.js";

describe("createPaperclipHttp wakeup", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("puts issueId in payload, not at the top level", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const pc = createPaperclipHttp({
      apiUrl: "http://127.0.0.1:3100",
      authToken: "test-token",
      runId: "run-1",
    });
    const result = await pc.wakeup("agent-jules", "reattach after process-lost", "issue-821");
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      source: "on_demand",
      triggerDetail: "ping",
      reason: "reattach after process-lost",
      forceFreshSession: false,
      payload: { issueId: "issue-821" },
    });
    expect(body.issueId).toBeUndefined();
    expect(new Headers(init.headers).get("X-Paperclip-Run-Id")).toBe("run-1");
  });

  it("does not retry a forbidden cross-agent wakeup as the board actor", async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"cross_issue_influence_run_context_required"}', { status: 403 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const pc = createPaperclipHttp({
      apiUrl: "http://127.0.0.1:3100",
      authToken: "test-token",
      runId: "run-1",
    });
    const result = await pc.wakeup("agent-jules", "continue", "issue-821");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends an explicit resume run inside the issue payload", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const pc = createPaperclipHttp({ apiUrl: "http://127.0.0.1:3100", authToken: "test-token" });
    await pc.wakeup("agent-jules", "poll", "issue-834", { resumeFromRunId: "run-previous" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).payload).toEqual({
      issueId: "issue-834",
      resumeFromRunId: "run-previous",
    });
  });

  it("carries native review feedback as structured wake payload", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const pc = createPaperclipHttp({ apiUrl: "http://127.0.0.1:3100", authToken: "test-token" });
    const feedback = {
      version: 1 as const,
      kind: "code_review_rejection" as const,
      deliveryId: "delivery-1",
      issueId: "issue-955",
      reviewInteractionId: "interaction-1",
      reviewStage: "luna" as const,
      prUrl: "https://github.com/acme/repo/pull/1",
      headSha: "abc123",
      reason: "Add the missing regression test.",
      createdAt: "2026-09-03T00:00:00.000Z",
    };
    await pc.wakeup("agent-jules", "review feedback", "issue-955", { workerFeedback: feedback });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).payload.workerFeedback).toEqual(feedback);
    expect(new Headers(init.headers).get("Idempotency-Key")).toContain("delivery-1");
  });

  it("carries the native review interaction identity in the wake payload", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const pc = createPaperclipHttp({ apiUrl: "http://127.0.0.1:3100", authToken: "test-token" });

    await pc.wakeup("agent-terra", "review the native card", "issue-955", {
      reviewInteractionId: "interaction-955",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).payload).toEqual({
      issueId: "issue-955",
      interactionId: "interaction-955",
      interactionKind: "request_item_verdicts",
    });
  });

  it("sends a stable idempotency key for a wakeup mutation", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const pc = createPaperclipHttp({ apiUrl: "http://127.0.0.1:3100", authToken: "test-token" });
    await pc.wakeup("agent-jules", "poll", "issue-834", { idempotencyKey: "wake:issue-834:cursor-1" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("wake:issue-834:cursor-1");
  });

  it("cancels a stale heartbeat run through the board recovery route", async () => {
    const fetchMock = vi.fn(async () => new Response('{"status":"cancelled"}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const pc = createPaperclipHttp({ apiUrl: "http://127.0.0.1:3100", localTrustedBoardWrites: true });
    await expect(pc.cancelHeartbeatRun("run-stale", "recover review")).resolves.toMatchObject({ ok: true, data: { status: "cancelled" } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3100/api/heartbeat-runs/run-stale/cancel");
  });

  it("uses the implicit local board actor for company-level mutations", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const pc = createPaperclipHttp({
      apiUrl: "http://127.0.0.1:3100",
      authToken: "agent-token",
      runId: "company-run-without-source-issue",
      localTrustedBoardWrites: true,
    });
    await pc.patchIssue("issue-834", { status: "in_progress" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-Paperclip-Run-Id")).toBeNull();
  });

  it("adds a deterministic idempotency key to ordinary issue mutations", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const pc = createPaperclipHttp({ apiUrl: "http://127.0.0.1:3100", authToken: "test-token" });
    await pc.patchIssue("issue-834", { status: "todo" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(/^paperclip:(PATCH|POST|DELETE):/);
  });

  it("retries a transient ordinary mutation with the same idempotency key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const pc = createPaperclipHttp({ apiUrl: "http://127.0.0.1:3100", authToken: "test-token" });
    await pc.patchIssue("issue-834", { status: "todo" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = new Headers((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers).get("Idempotency-Key");
    const second = new Headers((fetchMock.mock.calls[1] as [string, RequestInit])[1].headers).get("Idempotency-Key");
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("fetches an enriched issue detail for work-product recovery", async () => {
    const fetchMock = vi.fn(async () => new Response('{"workProducts":[]}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const pc = createPaperclipHttp({ apiUrl: "http://127.0.0.1:3100", authToken: "test-token" });
    await expect(pc.getIssue("issue/834")).resolves.toEqual({ workProducts: [] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3100/api/issues/issue%2F834");
  });

  it("patches a merged work product through the dedicated route", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const pc = createPaperclipHttp({ apiUrl: "http://127.0.0.1:3100", localTrustedBoardWrites: true });
    await expect(pc.patchWorkProduct("wp-834", { status: "merged", reviewState: "approved" })).resolves.toMatchObject({ ok: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3100/api/work-products/wp-834");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("PATCH");
  });

  it("creates and lists native issue interactions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"id":"dialog-1"}', { status: 201 }))
      .mockResolvedValueOnce(new Response('{"interactions":[{"id":"dialog-1"}]}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const pc = createPaperclipHttp({ apiUrl: "http://127.0.0.1:3100", authToken: "test-token" });
    await expect(pc.createInteraction("issue-834", { kind: "request_item_verdicts" })).resolves.toMatchObject({ ok: true, data: { id: "dialog-1" } });
    await expect(pc.listInteractions("issue-834")).resolves.toEqual({ interactions: [{ id: "dialog-1" }] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3100/api/issues/issue-834/interactions");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://127.0.0.1:3100/api/issues/issue-834/interactions");
  });

  it("withdraws a stale interaction through its dedicated endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const pc = createPaperclipHttp({ apiUrl: "http://127.0.0.1:3100", authToken: "test-token" });
    await expect(pc.withdrawInteraction("issue-834", "dialog-1", "new PR head")).resolves.toMatchObject({ ok: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3100/api/issues/issue-834/interactions/dialog-1/withdraw");
  });
});
