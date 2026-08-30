import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addJulesActivityComment,
  createJulesFeedbackInteraction,
  createJulesPlanApprovalInteraction,
  createNoPrCompletionInteraction,
  moveIssueToBlocked,
  moveIssueToDone,
  moveIssueToReview,
  PaperclipClientError,
} from "../src/server/paperclip-client";

describe("Paperclip issue completion", () => {
  afterEach(() => vi.restoreAllMocks());

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
});
