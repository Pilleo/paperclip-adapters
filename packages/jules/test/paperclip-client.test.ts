import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addJulesActivityComment,
  activateInternalReviewIssue,
  answerJulesAgentAdjudicationInteraction,
  clearJulesSessionMonitor,
  completeInternalReviewIssue,
  createIssueComment,
  createJulesFeedbackInteraction,
  createJulesHumanEscalationInteraction,
  createJulesAgentAdjudicationInteraction,
  createJulesQuestionAdjudication,
  createJulesQuestionReviewInteraction,
  createJulesPlanApprovalInteraction,
  createNoPrCompletionInteraction,
  getPaperclipInteraction,
  getPaperclipIssue,
  hasFutureJulesSessionMonitor,
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
  isPaperclipChildLimitError,
  paperclipRequestForInternalUse,
} from "../src/server/paperclip-client";

describe("native Jules plan review interaction", () => {
  it("preserves the typed payload when reading an answered interaction", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([{
      id: "plan-review-answered", status: "answered", kind: "request_item_verdicts",
      payload: { items: [{ id: "plan" }], target: { type: "issue_document", key: "plan" } },
      result: { outcome: "resolved", complete: true },
    }]), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(listPaperclipInteractions("issue-1", "token", "run-1")).resolves.toMatchObject([{
      id: "plan-review-answered",
      payload: { items: [{ id: "plan" }] },
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it("builds an addressed typed plan verdict interaction with a required reason for rejection", async () => {
    // This test is intentionally added before the implementation. The plan
    // review protocol must be a Paperclip interaction, never a comment.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "plan-review-1", status: "pending", kind: "request_item_verdicts",
    }), { status: 201, headers: { "content-type": "application/json" } }));

    const { createJulesPlanReviewInteraction } = await import("../src/server/paperclip-client");
    await createJulesPlanReviewInteraction(
      "issue-1", "session-1", { documentId: "document-1", revisionId: "revision-1", revisionNumber: 1 },
      "# Plan", "luna", "reviewer-1", "token", "run-1",
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.kind).toBe("request_item_verdicts");
    expect(body.addresseeAgentId).toBe("reviewer-1");
    expect(body.payload.items).toEqual([{ id: "plan", label: "Plan", description: "Plan revision 1" }]);
    expect(body.payload.verdicts).toEqual(["approve", "reject"]);
    expect(body.payload.target.revisionId).toBe("revision-1");
    fetchMock.mockRestore();
  });

  it.each([
    { label: "large markdown plan", plan: "# Plan\n\n" + "- implement typed transition\n".repeat(900) },
    { label: "unicode plan", plan: "修正計画 🚦\n" + "步骤：验证状态机 ✅\n".repeat(1200) },
  ])("keeps $label inside Paperclip confirmation limits while preserving the target", async ({ plan }) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "plan-review-long-1", status: "pending", kind: "request_confirmation",
    }), { status: 201, headers: { "content-type": "application/json" } }));

    const { createJulesPlanReviewInteraction } = await import("../src/server/paperclip-client");
    await createJulesPlanReviewInteraction(
      "issue-1", "session-1", { documentId: "document-1", revisionId: "revision-1", revisionNumber: 7 },
      plan, "terra", "reviewer-1", "token", "run-1",
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.payload.prompt.length).toBeLessThanOrEqual(1000);
    expect(body.payload.detailsMarkdown.length).toBeLessThanOrEqual(20_000);
    expect(body.payload.detailsMarkdown).toContain("Review target: plan revision 7");
    expect(body.payload.target).toEqual({
      type: "issue_document",
      issueId: "issue-1",
      documentId: "document-1",
      key: "plan",
      revisionId: "revision-1",
      revisionNumber: 7,
    });
    fetchMock.mockRestore();
  });
});

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
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, status: 201 });

    await addJulesActivityComment("issue-1", "activity-1", "**Jules**\n\nWhich branch?", "https://jules.example/s/1", "jwt-token", "run-1");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/issues/issue-1/comments",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Paperclip-Run-Id": "run-1" }),
        body: expect.stringContaining("<!-- jules-activity:activity-1 -->"),
      }),
    );
  });

  it("does not mirror an activity already present in the issue comments", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ body: "<!-- jules-activity:activity-1 -->\nold mirror" }],
    });

    await addJulesActivityComment("issue-1", "activity-1", "Which branch?", undefined, "jwt-token");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/comments"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("serializes concurrent mirrors for the same provider activity", async () => {
    let posted = false;
    global.fetch = vi.fn().mockImplementation(async (_url: string, request?: RequestInit) => {
      if (request?.method === "POST") {
        posted = true;
        return { ok: true, status: 201 };
      }
      return {
        ok: true,
        status: 200,
        json: async () => posted ? [{ body: "<!-- jules-activity:activity-1 -->" }] : [],
      };
    });

    await Promise.all([
      addJulesActivityComment("issue-1", "activity-1", "Which branch?", undefined, "jwt-token"),
      addJulesActivityComment("issue-1", "activity-1", "Which branch?", undefined, "jwt-token"),
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(global.fetch.mock.calls.filter(([, request]) => (request as RequestInit)?.method === "POST")).toHaveLength(1);
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

  it("creates a human-only escalation form distinct from ordinary Jules feedback", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 201, json: async () => ({ id: "human-escalation-1", status: "pending" }),
    });

    await createJulesHumanEscalationInteraction(
      "issue-1", "session-1", "activity-1", "Which monitor API should I use?", "The strong reviewer lacks a repository-backed answer.", "jwt-token",
    );

    const request = vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      idempotencyKey: "jules:human-escalation:issue-1:session-1:activity-1",
      title: "Human decision needed for Jules",
      resolverPolicy: "human_only",
    });
    // Keep the ordinary reply schema: the existing feedback-resolution path
    // can therefore relay the human answer without a parallel state machine.
    expect(body.payload.questions).toEqual([expect.objectContaining({
      id: "reply",
      required: true,
      options: [expect.objectContaining({ id: "response", freeText: true })],
    })]);
  });

  it("recovers a duplicate human escalation only by its exact idempotency key", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, text: async () => "duplicate" })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { id: "ordinary-feedback", kind: "ask_user_questions", status: "pending", idempotencyKey: "jules:user-feedback:issue-1:s-1:a-1:1" },
          { id: "human-escalation", kind: "ask_user_questions", status: "pending", idempotencyKey: "jules:human-escalation:issue-1:s-1:a-1" },
        ],
      });

    await expect(createJulesHumanEscalationInteraction(
      "issue-1", "s-1", "a-1", "Which API?", "The reviewer cannot determine that safely.", "jwt-token",
    )).resolves.toMatchObject({ id: "human-escalation" });
  });

  it("gives provider-question adjudicators a question-only protocol", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "adjudication-1", status: "todo" }),
    });

    await createJulesQuestionAdjudication(
      "issue-1", "reviewer-1", "Should I run the final checks and open the PR?", undefined,
    );

    const request = vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { description: string };
    expect(body.description).toContain("Answer only the quoted operational question");
    expect(body.description).toContain("Do not inspect or review the checkout, diff, tests, branches, pull requests, GitHub, or repository files");
    expect(body.description).toContain("direct workflow instruction");
    expect(body.description).toContain("Paperclip interaction attached to this issue is the only decision protocol");
    expect(body.description).not.toContain("exactly one JSON object as an issue comment");
    expect(body.description).not.toContain('"kind":"ANSWER"');
    expect(body.description).not.toContain("repository context");
    expect(body.description).not.toContain("codebase do not determine");
  });

  it("keeps deferred reviewer children unscheduled until their typed form is ready", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "deferred-child-1", status: "backlog",
    }), { status: 201, headers: { "content-type": "application/json" } }));

    await createJulesQuestionAdjudication(
      "parent-1", "reviewer-1", "Should I proceed?", undefined, undefined,
      undefined, undefined, undefined, 1, true,
    );

    const createBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(createBody.status).toBe("backlog");
    expect(createBody.assigneeAgentId).toBe("reviewer-1");
    fetchMock.mockRestore();
  });

  it("does not reuse a terminal reviewer child for a new question generation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: "old-done-child", status: "done", assigneeAgentId: "reviewer-1",
        description: "<!-- jules-question-adjudication:old -->",
      }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "new-child", status: "backlog" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createJulesQuestionAdjudication(
      "parent-1", "reviewer-1", "A new question", undefined, undefined,
      "company-1", "activity-1", "session-1", 1, true,
    )).resolves.toMatchObject({ id: "new-child" });

    expect(fetchMock.mock.calls.some(([, init]) =>
      (init as RequestInit)?.method === "POST" &&
      String((init as RequestInit)?.body).includes('"status":"backlog"'),
    )).toBe(true);
    vi.unstubAllGlobals();
  });

  it("activates a deferred reviewer only after the typed form was posted", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await activateInternalReviewIssue("child-1", "reviewer-1", undefined);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      status: "todo", assigneeAgentId: "reviewer-1", blockParentUntilDone: false,
    });
    fetchMock.mockRestore();
  });

  it("creates a visible parent record without stealing the Jules assignment", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 201, json: async () => ({ id: "visible-1", status: "pending" }),
    });

    await createJulesAgentAdjudicationInteraction(
      "issue-1", "session-1", "activity-1", "Which branch should I use?", "terra-1", undefined,
    );

    const request = vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      continuationPolicy: "wake_assignee",
      kind: "ask_user_questions",
    });
    expect(body.payload.questions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "resolution", options: expect.arrayContaining([
        expect.objectContaining({ id: "answer" }), expect.objectContaining({ id: "escalate" }),
      ]) }),
      expect.objectContaining({ id: "response" }),
    ]));
  });

  it("creates the reviewer form on the Terra-owned child, not the Jules parent", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 201, json: async () => ({ id: "child-form-1", status: "pending", kind: "ask_user_questions" }),
    });

    await createJulesQuestionReviewInteraction(
      "child-1", "parent-1", "session-1", "activity-1", "Should I submit?", "terra-1", undefined,
    );

    const request = vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.kind).toBe("ask_user_questions");
    expect(body.addresseeAgentId).toBe("terra-1");
    expect(body.continuationPolicy).toBe("wake_assignee");
    expect(body.idempotencyKey).toBe("jules:question-review:child-1:parent-1:session-1:activity-1");
    expect(body.payload.questions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "resolution" }),
      expect.objectContaining({ id: "response" }),
    ]));
    expect(body.payload.questions.find((question: { id: string }) => question.id === "response").helpText)
      .toContain('answers: [{ questionId: "resolution", optionIds: ["answer"] }, { questionId: "response", optionIds: ["response"], otherText: "..." }]');
  });

  it("treats a concurrent already-resolved adjudication response as success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, text: async () => JSON.stringify({ code: "interaction_already_resolved" }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: "visible-1", status: "answered", kind: "ask_user_questions" }],
      });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(answerJulesAgentAdjudicationInteraction(
      "issue-1", "visible-1", "Run the declared checks.", undefined,
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://127.0.0.1:3100/api/issues/issue-1/interactions");
  });

  it("treats a concurrently withdrawn parent adjudication as converged", async () => {
    // A recovery heartbeat can withdraw the visible audit card while the
    // reviewer-child heartbeat is consuming its typed decision. The reviewer
    // decision remains authoritative for Jules; a 409 from that audit write
    // must not turn a healthy provider session into a failed polling run.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, text: async () => JSON.stringify({ code: "interaction_already_resolved" }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: "visible-1", status: "cancelled", kind: "ask_user_questions" }],
      });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(answerJulesAgentAdjudicationInteraction(
      "issue-1", "visible-1", "Run the declared checks.", undefined,
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats withdrawal of an already-terminal interaction as converged", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, text: async () => JSON.stringify({ code: "interaction_already_resolved" }) })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => [{ id: "plan-card-1", status: "cancelled", kind: "request_item_verdicts" }],
      });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(withdrawPaperclipInteraction(
      "issue-1", "plan-card-1", "Superseded by exact PR feedback.", undefined,
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses local trusted board fallback for legacy parent cards addressed to Terra", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ code: "interaction_addressee_mismatch" }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(answerJulesAgentAdjudicationInteraction(
      "issue-1", "visible-1", "Proceed.", "internal-token", "jules-run-1",
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      headers: expect.not.objectContaining({ "X-Paperclip-Run-Id": "jules-run-1" }),
    }));
  });

  it("classifies Paperclip's helper-child cap without broadening the match", () => {
    expect(isPaperclipChildLimitError(new PaperclipClientError(422, "Parent issue already has the maximum 25 child issues for this helper"))).toBe(true);
    expect(isPaperclipChildLimitError(new PaperclipClientError(422, "invalid issue"))).toBe(false);
    expect(isPaperclipChildLimitError(new PaperclipClientError(409, "Parent issue already has the maximum 25 child issues for this helper"))).toBe(false);
  });

  it("creates a fresh standalone adjudicator when Paperclip reaches the helper-child cap", async () => {
    const fetchMock = vi.fn()
      // Existing-child lookup before creation.
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] })
      // Paperclip's per-parent helper cap.
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => "Parent issue already has the maximum 25 child issues for this helper",
      })
      // Fallback lookup after the cap.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{
          id: "old-adjudication",
          parentId: "issue-1",
          title: "Adjudicate Jules provider question",
          status: "done",
          assigneeAgentId: "reviewer-1",
        }],
      })
      // Fresh company-level reviewer task.
      .mockResolvedValueOnce({
        ok: true, status: 201,
        json: async () => ({ id: "standalone-adjudication", status: "todo" }),
      })
      // Normalize the adapter-owned issue.
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ id: "standalone-adjudication", status: "todo" }),
      });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(createJulesQuestionAdjudication(
      "issue-1", "reviewer-1", "Which branch should I use?", "jwt-token", "run-1", "company-1",
    )).resolves.toMatchObject({ id: "standalone-adjudication", status: "todo" });

    const createFallback = fetchMock.mock.calls.find(([url, request]) =>
      url === "http://127.0.0.1:3100/api/companies/company-1/issues" &&
      (request as RequestInit)?.method === "POST",
    );
    expect(createFallback).toBeDefined();
    expect(JSON.parse(String(createFallback?.[1]?.body))).toMatchObject({
      companyId: "company-1",
      assigneeAgentId: "reviewer-1",
      blockParentUntilDone: false,
      // Paperclip's company-level create endpoint deduplicates recent issues by
      // title. Every provider question needs a fresh issue context; otherwise
      // the reviewer can answer a previous question while resolving the new
      // interaction.
      allowDuplicate: true,
    });
    const normalizePatch = fetchMock.mock.calls.find(([url, request]) =>
      url === "http://127.0.0.1:3100/api/issues/standalone-adjudication" &&
      (request as RequestInit)?.method === "PATCH",
    );
    expect(normalizePatch).toBeDefined();
    expect(JSON.parse(String(normalizePatch?.[1]?.body))).toMatchObject({
      assigneeAgentId: "reviewer-1",
      blockParentUntilDone: false,
    });
    expect(JSON.parse(String(createFallback?.[1]?.body)).description).toContain(
      "Which branch should I use?",
    );
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

  it("marks an existing matching PR as the canonical Jules work product", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: "wp-5", url: "https://github.com/o/r/pull/5", isPrimary: false, metadata: { source: "jules" } }] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "wp-5" }) });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await registerPullRequestWorkProduct("issue-1", "https://github.com/o/r/pull/5", "jwt-token", "run-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/work-products/wp-5");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      isPrimary: true,
      metadata: { source: "jules", producer: "paperclip-jules-adapter", schemaVersion: 1 },
    });
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
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "issue-1", status: "in_progress", executionPolicy: { mode: "normal", monitor: { serviceName: "jules", externalRef: "s-1", nextCheckAt: "2026-08-31T12:00:00Z" } } }) })
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

  it("rejects a successful monitor write that does not echo a verified Jules monitor", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "issue-1", status: "in_progress", executionPolicy: null }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "issue-1", status: "in_progress", executionPolicy: null }) });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(scheduleJulesSessionMonitor(
      "issue-1", "s-1", "2026-08-31T12:00:00Z", "2026-09-01T12:00:00Z", "jwt-token", "run-1",
    )).rejects.toThrow(/verified Jules monitor/i);
  });

  it("accepts Paperclip's redacted externalRef in a verified monitor receipt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "issue-1", executionPolicy: null }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: "issue-1",
          executionPolicy: {
            monitor: {
              serviceName: "jules",
              externalRef: "[redacted]",
              nextCheckAt: "2026-08-31T12:00:00Z",
            },
          },
        }),
      });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(scheduleJulesSessionMonitor(
      "issue-1", "s-1", "2026-08-31T12:00:00Z", "2026-09-01T12:00:00Z", "jwt-token", "run-1",
    )).resolves.toBeUndefined();
  });

  it("reuses a matching future Jules monitor instead of replacing its deadline", async () => {
    // Event-driven wakes (for example, a resolved review form) may arrive
    // between provider polls. Replacing an already-durable monitor both
    // postpones the provider check and lets Paperclip's stale timer callback
    // race the new monitor. Reuse is the only safe no-op in this state.
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "issue-1",
        executionPolicy: {
          monitor: {
            serviceName: "jules",
            externalRef: "s-1",
            nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      }),
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await scheduleJulesSessionMonitor(
      "issue-1", "s-1", new Date(Date.now() + 15 * 60_000).toISOString(),
      new Date(Date.now() + 24 * 60 * 60_000).toISOString(), "jwt-token", "run-1",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("recognizes a redacted future monitor for the active Jules session", async () => {
    // Paperclip intentionally redacts the provider handle in normal issue
    // projections. A redundant event wake must still be able to defer to the
    // durable monitor, rather than paying for another cloud status poll.
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "issue-1",
        executionPolicy: {
          monitor: {
            serviceName: "jules",
            externalRef: "[redacted]",
            nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      }),
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(hasFutureJulesSessionMonitor("issue-1", "s-1", "jwt-token", "run-1")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("repairs and verifies a triggered Jules monitor whose execution policy was stripped", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: "issue-1",
          status: "in_progress",
          executionPolicy: null,
          executionState: {
            monitor: { serviceName: "jules", externalRef: "s-1", timeoutAt: "2026-09-01T00:00:00Z" },
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "issue-1", executionPolicy: { mode: "normal" }, executionState: { monitor: null } }),
      });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await clearJulesSessionMonitor("issue-1", "jwt-token");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).executionPolicy.monitor).toMatchObject({
      serviceName: "jules",
      externalRef: "s-1",
    });
    expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body as string).executionPolicy).toEqual({
      mode: "normal",
      stages: [],
      commentRequired: false,
    });
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
