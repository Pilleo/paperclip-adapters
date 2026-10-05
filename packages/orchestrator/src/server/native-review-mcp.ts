import type { NativeReviewAssignmentResult, NativeReviewSubmissionResult, NativeReviewVerdict } from "../core/native-review-submission.js";

/** The sole tool exposed to managed read-only review agents. */
export const NATIVE_REVIEW_MCP_TOOL = "submit_native_review_verdict" as const;
/** Read-only assignment context; reviewers must inspect this before deciding. */
export const NATIVE_REVIEW_ASSIGNMENT_MCP_TOOL = "get_current_native_review_assignment" as const;
/** The sole decision channel for a Jules provider-question adjudication. */
export const JULES_QUESTION_MCP_TOOL = "submit_jules_question_decision" as const;

export interface NativeReviewToolArguments {
  readonly verdict: NativeReviewVerdict;
  readonly reason?: string;
}

export interface JulesQuestionToolArguments {
  readonly decision: "answer" | "escalate";
  readonly response: string;
}

type InvalidToolArguments = { readonly ok: false; readonly message: string };
type ValidToolArguments = { readonly ok: true; readonly value: NativeReviewToolArguments };
export type NativeReviewToolArgumentsResult = ValidToolArguments | InvalidToolArguments;

export function parseNativeReviewToolArguments(value: unknown): NativeReviewToolArgumentsResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "arguments must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  const verdict = raw["verdict"];
  const reason = raw["reason"];
  if (keys.some((key) => key !== "verdict" && key !== "reason")) {
    return { ok: false, message: "only verdict and reason are accepted" };
  }
  if (verdict !== "approve" && verdict !== "reject") {
    return { ok: false, message: "verdict must be approve or reject" };
  }
  if (reason !== undefined && (typeof reason !== "string" || !reason.trim())) {
    return { ok: false, message: "reason must be a non-empty string when provided" };
  }
  switch (verdict) {
    case "approve":
      return { ok: true, value: { verdict: "approve" } };
    case "reject":
      if (typeof reason !== "string") return { ok: false, message: "reject requires a concrete reason" };
      return { ok: true, value: { verdict: "reject", reason: reason.trim() } };
  }
}

export function parseJulesQuestionToolArguments(value: unknown):
  | { readonly ok: true; readonly value: JulesQuestionToolArguments }
  | InvalidToolArguments {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "arguments must be an object" };
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "decision" && key !== "response")) {
    return { ok: false, message: "only decision and response are accepted" };
  }
  const decision = raw["decision"];
  const response = raw["response"];
  if (decision !== "answer" && decision !== "escalate") {
    return { ok: false, message: "decision must be answer or escalate" };
  }
  if (typeof response !== "string" || !response.trim()) {
    return { ok: false, message: "response must be a non-empty string" };
  }
  return { ok: true, value: { decision, response: response.trim() } };
}

export interface NativeReviewMcpRequest {
  readonly method: string;
  readonly params?: { readonly name?: unknown; readonly arguments?: unknown };
}

export interface NativeReviewMcpResponse {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: Record<string, unknown>;
  readonly isError: boolean;
}

const FATAL_NATIVE_REVIEW_CODES = new Set([
  "review_artifact_unavailable", "review_artifact_head_changed", "review_artifact_too_large",
  "missing_runtime_context",
  "missing_runtime_auth",
  "runtime_transport_error",
  "list_http_error",
  "list_invalid_response",
  "no_owned_pending_card",
  "ambiguous_owned_pending_cards",
  "malformed_review_card",
  "submit_http_error",
  "submit_invalid_response",
  "invalid_identity",
  "evidence_unavailable",
  "invalid_card_evidence",
  "untrusted_plan_verdict",
  "stale_plan_revision",
  "unowned_review_policy",
  "unexpected_issue_state",
  "handback_failed",
  "child_plan_cleanup_failed",
]);

/**
 * A control-plane failure must fail the enclosing run. Otherwise Codex may
 * exit successfully after receiving an MCP error while the durable card is
 * still pending, leaving the orchestrator with no recoverable signal.
 */
export function isFatalNativeReviewMcpError(response: unknown): boolean {
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  const value = response as Record<string, unknown>;
  const structuredContent = value["structuredContent"];
  if (value["isError"] !== true || !structuredContent || typeof structuredContent !== "object" || Array.isArray(structuredContent)) {
    return false;
  }
  const code = (structuredContent as Record<string, unknown>)["code"];
  return typeof code === "string" && FATAL_NATIVE_REVIEW_CODES.has(code);
}

export function createNativeReviewMcpHandler(input: {
  readonly submit: (arguments_: NativeReviewToolArguments) => Promise<NativeReviewSubmissionResult>;
  readonly readAssignment?: () => Promise<NativeReviewAssignmentResult>;
  readonly submitJulesQuestion?: (arguments_: JulesQuestionToolArguments) => Promise<
    | { readonly ok: true; readonly interactionId: string; readonly decision: JulesQuestionToolArguments["decision"] }
    | { readonly ok: false; readonly code: string }
  >;
}): (request: NativeReviewMcpRequest) => Promise<NativeReviewMcpResponse> {
  return async (request) => {
    if (request.method !== "tools/call") {
      return toolError("unsupported_tool", "Only the native review verdict tool is available.");
    }
    switch (request.params?.name) {
      case JULES_QUESTION_MCP_TOOL: {
        const parsed = parseJulesQuestionToolArguments(request.params.arguments);
        if (!parsed.ok) return toolError("invalid_arguments", parsed.message);
        if (!input.submitJulesQuestion) return toolError("unsupported_tool", "Jules question submission is unavailable.");
        try {
          const submitted = await input.submitJulesQuestion(parsed.value);
          if (!submitted.ok) return toolError(submitted.code, "The typed Jules decision was not submitted.");
          return {
            content: [{ type: "text", text: `Typed Jules ${submitted.decision} submitted for card ${submitted.interactionId}.` }],
            structuredContent: { interactionId: submitted.interactionId, decision: submitted.decision },
            isError: false,
          };
        } catch {
          return toolError("runtime_transport_error", "The Paperclip review service is temporarily unavailable.");
        }
      }
      case NATIVE_REVIEW_ASSIGNMENT_MCP_TOOL: {
        if (request.params.arguments !== undefined &&
            (typeof request.params.arguments !== "object" || request.params.arguments === null ||
              Array.isArray(request.params.arguments) || Object.keys(request.params.arguments as object).length > 0)) {
          return toolError("invalid_arguments", "The native review assignment tool accepts no arguments.");
        }
        if (!input.readAssignment) return toolError("unsupported_tool", "Native review assignment lookup is unavailable.");
        try {
          const result = await input.readAssignment();
          if (!result.ok) return toolError(result.code, "The typed native review assignment is unavailable.");
          return {
            content: [{ type: "text", text: result.assignment.kind === "plan_review_recorded"
              ? "The typed child plan verdict is already recorded. Do not submit another verdict or change parent ownership; Jules consumes the recorded result."
              : `Typed ${result.assignment.kind} review assignment loaded.` }],
            structuredContent: result.assignment,
            isError: false,
          };
        } catch {
          return toolError("runtime_transport_error", "The Paperclip review service is temporarily unavailable.");
        }
      }
      case NATIVE_REVIEW_MCP_TOOL: {
        const parsed = parseNativeReviewToolArguments(request.params.arguments);
        if (!parsed.ok) return toolError("invalid_arguments", parsed.message);

        let submitted: NativeReviewSubmissionResult;
        try {
          submitted = await input.submit(parsed.value);
        } catch {
          return toolError("runtime_transport_error", "The Paperclip review service is temporarily unavailable.");
        }
        if (!submitted.ok) return toolError(submitted.code, "The structured verdict was not submitted.");
        const label = submitted.verdict === "approve" ? "approval" : "rejection";
        return {
          content: [{ type: "text", text: `Structured ${label} submitted for card ${submitted.interactionId}.` }],
          structuredContent: {
            interactionId: submitted.interactionId,
            itemId: submitted.itemId,
            verdict: submitted.verdict,
          },
          isError: false,
        };
      }
      default:
        return toolError("unsupported_tool", "Only the native review verdict tool is available.");
    }
  };
}

function toolError(code: string, message: string): NativeReviewMcpResponse {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { code },
    isError: true,
  };
}
