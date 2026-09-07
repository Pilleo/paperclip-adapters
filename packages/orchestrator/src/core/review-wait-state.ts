import type { PrReviewStage } from "./review-interaction-state.js";

export interface ReviewWaitState {
  readonly version: 1;
  readonly status: "waiting_for_reviewer";
  readonly reviewRequest: { readonly kind: "pull_request"; readonly stage: PrReviewStage };
  readonly prUrl: string;
  readonly headSha: string;
  readonly reviewerAgentId: string;
  readonly reviewerStatus: string;
  readonly reason: string;
  readonly circuitKey: string;
  readonly updatedAt: string;
}

export function buildReviewWaitState(input: Omit<ReviewWaitState, "version" | "status" | "reviewRequest" | "updatedAt"> & { readonly stage: PrReviewStage; readonly now?: string }): ReviewWaitState {
  return { version: 1, status: "waiting_for_reviewer", reviewRequest: { kind: "pull_request", stage: input.stage }, prUrl: input.prUrl, headSha: input.headSha, reviewerAgentId: input.reviewerAgentId, reviewerStatus: input.reviewerStatus, reason: input.reason, circuitKey: input.circuitKey, updatedAt: input.now || new Date().toISOString() };
}

export function isReviewWaitState(value: unknown): value is ReviewWaitState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const request = state["reviewRequest"];
  return state["version"] === 1 && state["status"] === "waiting_for_reviewer" && typeof state["prUrl"] === "string" && typeof state["headSha"] === "string" && typeof state["reviewerAgentId"] === "string" && typeof state["reviewerStatus"] === "string" && typeof state["reason"] === "string" && typeof state["circuitKey"] === "string" && typeof state["updatedAt"] === "string" && !!request && typeof request === "object" && (request as Record<string, unknown>)["kind"] === "pull_request" && ["luna", "terra", "vibe", "strong"].includes(String((request as Record<string, unknown>)["stage"]));
}

export function reviewWaitStateMatches(value: unknown, identity: { readonly prUrl: string; readonly headSha: string; readonly stage: PrReviewStage; readonly reviewerAgentId: string }): boolean {
  return isReviewWaitState(value) && value.prUrl === identity.prUrl && value.headSha === identity.headSha && value.reviewRequest.stage === identity.stage && value.reviewerAgentId === identity.reviewerAgentId;
}
