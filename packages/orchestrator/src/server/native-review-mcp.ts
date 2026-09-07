import type { NativeReviewSubmissionResult, NativeReviewVerdict } from "../core/native-review-submission.js";

/** The sole tool exposed to managed read-only review agents. */
export const NATIVE_REVIEW_MCP_TOOL = "submit_native_review_verdict" as const;

export interface NativeReviewToolArguments {
  readonly verdict: NativeReviewVerdict;
  readonly reason?: string;
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
}): (request: NativeReviewMcpRequest) => Promise<NativeReviewMcpResponse> {
  return async (request) => {
    if (request.method !== "tools/call" || request.params?.name !== NATIVE_REVIEW_MCP_TOOL) {
      return toolError("unsupported_tool", "Only the native review verdict tool is available.");
    }
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
  };
}

function toolError(code: string, message: string): NativeReviewMcpResponse {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { code },
    isError: true,
  };
}
