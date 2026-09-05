import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addJulesActivityComment,
  activateInternalReviewIssue,
  answerJulesAgentAdjudicationInteraction,
  clearJulesSessionMonitor,
  completeInternalReviewIssue,
  createIssueComment,
  createJulesFeedbackInteraction,
  createJulesPlanApprovalInteraction,
  createNoPrCompletionInteraction,
  getPaperclipInteraction,
  getPaperclipIssue,
  listIssueComments,
  listPaperclipApprovals,
  listPaperclipInteractions,
  listWorkProducts,
  moveIssueToBlocked,
  moveIssueToDone,
  moveIssueToInProgress,
  moveIssueToReview,
  normalizeInternalReviewIssue,
  PaperclipClientError,
  postSessionLink,
  readJulesSessionHandle,
  registerPullRequestWorkProduct,
  scheduleJulesSessionMonitor,
  upsertJulesSessionHandle,
  withdrawPaperclipInteraction,
  paperclipRequestForInternalUse,
} from "../src/server/paperclip-client";

describe("Paperclip issue completion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses Paperclip local-trusted mode without requiring an agent token", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await expect(paperclipRequestForInternalUse(
      "/api/issues/issue-1",
      undefined,
      { method: "GET" },
    )).resolves.toMatchObject({ ok: true });

    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.not.objectContaining({ Authorization: expect.anything() }),
      }),
    );
  });

  it("registers pull request work product when moving issue to review", async () => {
    const fetchMock = vi.fn()
      // GET work-products (dedupe guard): empty list -> POST proceeds
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] })
      // POST work-products
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await moveIssueToReview("issue-1", "https://github.com/example/repo/pull/1", "jwt-token");

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3100/api/issues/issue-1/work-products",
      expect.objectContaining({ method: "GET" }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3100/api/issues/issue-1/work-products",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"type":"pull_request"'),
      }),
    );
  });

  it("creates an idempotent no-PR completion confirmation", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "interaction-1", status: "pending" }),
    });

    await expect(createNoPrCompletionInteraction(
      "issue-1",
      "session-1",
      "https://jules.google.com/session/session-1",
      "jwt-token",
    )).resolves.toEqual({ id: "interaction-1", status: "pending" });

    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1/interactions",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"idempotencyKey":"jules:no-pr-completion:issue-1:session-1"'),
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.stringContaining('"continuationPolicy":"wake_assignee"') }),
    );
  });

  it("mirrors a Jules activity as an attributed Paperclip comment", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 201 });

    await addJulesActivityComment("issue-1", "activity-1", "**Jules**\n\nWhich branch?", "https://jules.example/s/1", "jwt-token", "run-1");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1/comments",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Paperclip-Run-Id": "run-1" }),
        body: expect.stringContaining("Which branch?"),
      }),
    );
  });

  it("creates stable feedback and plan approval interactions", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: "feedback-1", status: "pending" }) })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "missing" })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ id: "doc-1", latestRevisionId: "revision-1", latestRevisionNumber: 1 }),
      })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: "plan-1", status: "pending" }) });

    await createJulesFeedbackInteraction("issue-1", "session-1", "activity-1", "Which branch?", "jwt-token");
    await createJulesPlanApprovalInteraction("issue-1", "session-1", "activity-2", "**Jules plan**", "jwt-token");

    expect(global.fetch).toHaveBeenNthCalledWith(
      1, expect.any(String),
      expect.objectContaining({ body: expect.stringContaining('"idempotencyKey":"jules:user-feedback:issue-1:session-1:activity-1:1"') }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3, "http://127.0.0.1:3100/api/issues/issue-1/documents/plan",
      expect.objectContaining({ method: "PUT", body: expect.stringContaining('"baseRevisionId":null') }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      4, expect.any(String),
      expect.objectContaining({ body: expect.stringContaining('"idempotencyKey":"confirmation:issue-1:plan:revision-1"') }),
    );
    expect(JSON.parse(vi.mocked(global.fetch).mock.calls[3]![1]!.body as string).payload.target)
      .toMatchObject({ type: "issue_document", documentId: "doc-1", key: "plan", revisionId: "revision-1" });
  });

  it("supports explicit blocked and done dispositions", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await moveIssueToBlocked("issue-1", "jwt-token");
    await moveIssueToDone("issue-1", "session-1", "jwt-token");

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3100/api/issues/issue-1",
      expect.objectContaining({ body: JSON.stringify({ status: "blocked" }) }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3100/api/issues/issue-1",
      expect.objectContaining({ body: expect.stringContaining('"status":"done"') }),
    );
  });

  it("sends a stable idempotency key for ordinary mutations", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await moveIssueToBlocked("issue-1", "jwt-token");
    const request = vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toEqual(expect.objectContaining({
      "Idempotency-Key": expect.stringMatching(/^jules:paperclip:[a-f0-9]{64}$/),
    }));
  });

  it("retries transient Paperclip failures with the same idempotency key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "temporarily unavailable" })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await moveIssueToBlocked("issue-1", "jwt-token");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers;
    const secondHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers;
    expect(firstHeaders).toEqual(expect.objectContaining({ "Idempotency-Key": expect.any(String) }));
    expect(secondHeaders).toEqual(expect.objectContaining({
      "Idempotency-Key": (firstHeaders as Record<string, string>)["Idempotency-Key"],
    }));
  });

  it("does not retry a permanent authorization failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "forbidden" });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(moveIssueToBlocked("issue-1", "jwt-token")).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns typed failures for invalid Paperclip responses", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ status: "pending" }),
    });

    await expect(createNoPrCompletionInteraction(
      "issue-1",
      "session-1",
      undefined,
      "jwt-token",
    )).rejects.toBeInstanceOf(PaperclipClientError);
  });

  it("covers read-only issue, comment, interaction, approval, and work-product queries", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ url: "pr-1" }, { id: "ignored" }, null] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "issue-1", status: "in_progress" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: "comment-1", body: "hello", createdAt: "now" }] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: "i-1", status: "pending", kind: "ask_user_questions", payload: { target: { type: "x" } } }] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: "i-1", status: "pending", kind: "ask_user_questions", payload: { target: { type: "x" } } }] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ approvals: [{ id: "a-1", type: "interaction", status: "pending", issueIds: ["issue-1"], payload: { x: true } }, { id: 2, type: 3, status: 4 }] }) });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(listWorkProducts("issue-1", "jwt-token")).resolves.toEqual([{ url: "pr-1" }]);
    await expect(getPaperclipIssue("issue-1", "jwt-token")).resolves.toMatchObject({ status: "in_progress" });
    await expect(listIssueComments("issue-1", "jwt-token")).resolves.toHaveLength(1);
    await expect(listPaperclipInteractions("issue-1", "jwt-token")).resolves.toMatchObject([{ id: "i-1", target: { type: "x" } }]);
    await expect(getPaperclipInteraction("issue-1", "i-1", "jwt-token")).resolves.toMatchObject({ id: "i-1" });
    await expect(listPaperclipApprovals("company-1", "jwt-token")).resolves.toEqual([
      { id: "a-1", type: "interaction", status: "pending", issueIds: ["issue-1"], payload: { x: true } },
      { id: "2", type: "3", status: "4", issueIds: [] },
    ]);
  });

  it("is idempotent when the pull request work product already exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [{ url: "https://github.com/o/r/pull/1" }] });
    global.fetch = fetchMock as unknown as typeof global.fetch;
    await registerPullRequestWorkProduct("issue-1", "https://github.com/o/r/pull/1", "jwt-token", "run-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stores and reads a Jules session handle, falling back to comments", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ latestRevisionId: "rev-1" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ body: "julesSessionId: session-1\nurl: https://jules.google.com/session/session-1" }) })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "missing" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: "c", body: "Jules session: https://jules.google.com/session/session-2", createdAt: "now" }] });
    global.fetch = fetchMock as unknown as typeof global.fetch;
    await upsertJulesSessionHandle("issue-1", "session-1", "https://jules.google.com/session/session-1", "jwt-token");
    await expect(readJulesSessionHandle("issue-1", "jwt-token")).resolves.toBe("session-1");
    await expect(readJulesSessionHandle("issue-1", "jwt-token")).resolves.toBe("session-2");
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toMatchObject({ baseRevisionId: "rev-1" });
  });

  it("posts links/comments, withdraws interactions, and schedules durable monitoring", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201 })
      .mockResolvedValueOnce({ ok: true, status: 201 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "issue-1", status: "in_progress", executionPolicy: { mode: "normal", stages: ["review"], commentRequired: true, custom: "keep" } }) })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "issue-1", status: "in_progress", executionPolicy: { mode: "normal", monitor: { externalRef: "old" } } }) })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof global.fetch;
    await postSessionLink("issue-1", "https://jules.google.com/session/s-1", "jwt-token", "run-1");
    await createIssueComment("issue-1", "hello", "jwt-token");
    await withdrawPaperclipInteraction("issue-1", "interaction-1", "superseded", "jwt-token");
    await scheduleJulesSessionMonitor("issue-1", "s-1", "2026-08-31T12:00:00Z", "2026-09-01T12:00:00Z", "jwt-token");
    await clearJulesSessionMonitor("issue-1", "jwt-token");
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(JSON.parse(fetchMock.mock.calls[4]![1]!.body as string).executionPolicy).toMatchObject({ stages: [], commentRequired: false, custom: "keep" });
  });

  it("recovers an existing feedback interaction after an idempotency conflict", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, text: async () => "duplicate" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: "existing", status: "pending", kind: "ask_user_questions", idempotencyKey: "jules:user-feedback:issue-1:s-1:a-1:1" }] });
    await expect(createJulesFeedbackInteraction("issue-1", "s-1", "a-1", "question", "jwt-token")).resolves.toMatchObject({ id: "existing" });
  });

  it("repairs and completes an internal reviewer child explicitly", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof global.fetch;
    await normalizeInternalReviewIssue({ id: "child-1", status: "in_progress", executionPolicy: { stages: ["review"] } }, "jwt-token");
    await completeInternalReviewIssue("child-1", "jwt-token");
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ blockParentUntilDone: false, executionPolicy: { mode: "normal", stages: [], commentRequired: false } });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ status: "done", blockParentUntilDone: false, executionPolicy: { mode: "normal", stages: [], commentRequired: false } });
  });
});
