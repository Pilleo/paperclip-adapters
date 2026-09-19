import { describe, expect, it } from "vitest";
import {
  JULES_QUESTION_MCP_TOOL,
  NATIVE_REVIEW_ASSIGNMENT_MCP_TOOL,
  NATIVE_REVIEW_MCP_TOOL,
  createNativeReviewMcpHandler,
  isFatalNativeReviewMcpError,
  parseJulesQuestionToolArguments,
  parseNativeReviewToolArguments,
} from "../src/server/native-review-mcp.js";

describe("native reviewer MCP bridge", () => {
  it("returns the typed plan assignment before a reviewer submits a verdict", async () => {
    const handler = createNativeReviewMcpHandler({
      submit: async () => ({ ok: false, code: "no_owned_pending_card" }),
      readAssignment: async () => ({
        ok: true,
        assignment: {
          kind: "plan" as const,
          interactionId: "plan-card-1",
          itemId: "plan" as const,
          detailsMarkdown: "# Plan\n\nAdd subtraction.",
          target: {
            type: "issue_document" as const,
            issueId: "issue-1",
            documentId: "document-1",
            key: "plan" as const,
            revisionId: "revision-1",
            revisionNumber: 1,
          },
        },
      }),
    });

    await expect(handler({
      method: "tools/call",
      params: { name: NATIVE_REVIEW_ASSIGNMENT_MCP_TOOL, arguments: {} },
    })).resolves.toMatchObject({
      isError: false,
      structuredContent: { kind: "plan", interactionId: "plan-card-1", itemId: "plan" },
    });
  });

  it.each([
    ["approve", {}, { verdict: "approve" }],
    ["reject", { reason: "Add the missing regression test." }, { verdict: "reject", reason: "Add the missing regression test." }],
  ] as const)("accepts a typed %s verdict", (_name, input, expected) => {
    expect(parseNativeReviewToolArguments({ verdict: _name, ...input })).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["unknown verdict", { verdict: "comment" }],
    ["reject without a reason", { verdict: "reject" }],
    ["unexpected field", { verdict: "approve", cardId: "do-not-trust-model-input" }],
  ])("fails closed for %s", (_name, input) => {
    expect(parseNativeReviewToolArguments(input)).toMatchObject({ ok: false });
  });

  it("submits exactly one server-resolved card rather than emitting reviewer prose", async () => {
    const submissions: unknown[] = [];
    const handler = createNativeReviewMcpHandler({
      submit: async (input) => {
        submissions.push(input);
        return { ok: true, interactionId: "card-1", itemId: "review", verdict: "approve" };
      },
    });

    const response = await handler({
      method: "tools/call",
      params: { name: NATIVE_REVIEW_MCP_TOOL, arguments: { verdict: "approve" } },
    });

    expect(submissions).toEqual([{ verdict: "approve" }]);
    expect(response).toEqual({
      content: [{ type: "text", text: "Structured approval submitted for card card-1." }],
      structuredContent: { interactionId: "card-1", itemId: "review", verdict: "approve" },
      isError: false,
    });
  });

  it("submits a Jules answer through the sole addressed typed question card", async () => {
    const submissions: unknown[] = [];
    const handler = createNativeReviewMcpHandler({
      submit: async () => ({ ok: false, code: "no_owned_pending_card" }),
      submitJulesQuestion: async (input) => {
        submissions.push(input);
        return { ok: true, interactionId: "question-card-1", decision: "answer" as const };
      },
    });

    const response = await handler({
      method: "tools/call",
      params: {
        name: JULES_QUESTION_MCP_TOOL,
        arguments: { decision: "answer", response: "Proceed with the declared plan." },
      },
    });

    expect(submissions).toEqual([{ decision: "answer", response: "Proceed with the declared plan." }]);
    expect(response).toMatchObject({
      isError: false,
      structuredContent: { interactionId: "question-card-1", decision: "answer" },
    });
  });

  it.each([
    [{ decision: "answer" }],
    [{ decision: "escalate", response: "" }],
    [{ decision: "answer", response: "Proceed.", interactionId: "model-controlled" }],
  ])("rejects malformed Jules typed-answer arguments", (input) => {
    expect(parseJulesQuestionToolArguments(input)).toMatchObject({ ok: false });
  });

  it("reports an unavailable transport as a tool error and never falls back to a comment", async () => {
    const handler = createNativeReviewMcpHandler({
      submit: async () => ({ ok: false, code: "missing_runtime_context" }),
    });

    await expect(handler({
      method: "tools/call",
      params: { name: NATIVE_REVIEW_MCP_TOOL, arguments: { verdict: "approve" } },
    })).resolves.toMatchObject({ isError: true, structuredContent: { code: "missing_runtime_context" } });
  });

  it("contains a rejected control-plane request inside the typed tool result", async () => {
    const handler = createNativeReviewMcpHandler({
      submit: async () => { throw new Error("connect ECONNREFUSED"); },
    });

    await expect(handler({
      method: "tools/call",
      params: { name: NATIVE_REVIEW_MCP_TOOL, arguments: { verdict: "approve" } },
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: { code: "runtime_transport_error" },
    });
  });

  it.each([
    "missing_runtime_context",
    "runtime_transport_error",
    "list_http_error",
    "submit_http_error",
    "submit_invalid_response",
    "ambiguous_owned_pending_cards",
  ])("classifies %s as fatal reviewer infrastructure state", (code) => {
    expect(isFatalNativeReviewMcpError({ isError: true, structuredContent: { code } })).toBe(true);
  });

  it("keeps model-correctable argument errors non-fatal", () => {
    expect(isFatalNativeReviewMcpError({ isError: true, structuredContent: { code: "invalid_arguments" } })).toBe(false);
  });
});
