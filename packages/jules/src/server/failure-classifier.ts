import { JulesClientError, JulesFailure } from './jules-client.js';

export type AdapterExecutionErrorFamily = "transient_upstream" | "provider_quota" | "model_refusal" | "refresh_token_reused" | "refresh_token_expired" | "refresh_token_invalidated";

export type FailureClassification = "transient" | "configuration" | "task" | "unknown";

export function classifyFailure(error: unknown): FailureClassification {
  if (error instanceof JulesClientError) {
    if (error.status === 429 || error.status >= 500) {
      return "transient";
    }
    if (error.status === 401 || error.status === 403) {
      return "configuration";
    }
    if (error.status === 400 || error.status === 422) {
      return "task"; // Bad request or unprocessable entity
    }
  }

  if (error && typeof error === 'object' && ('message' in error || 'status' in error || 'code' in error)) {
      const f = error as JulesFailure;
      const message = (f.message || '').toLowerCase();
      const code = String(f.code || '');
      const status = String(f.status || '');

      if (status === 'UNAUTHENTICATED' || status === 'PERMISSION_DENIED' || code === '401' || code === '403') {
          return "configuration";
      }
      if (status === 'INVALID_ARGUMENT' || code === '400') {
          return "task";
      }
      if (status === 'UNAVAILABLE' || status === 'INTERNAL' || code === '429' || code === '503' || code === '500') {
          return "transient";
      }
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    if (message.includes('network') || message.includes('timeout') || message.includes('fetch failed')) {
      return "transient";
    }

    if (message.includes('unauthorized') || message.includes('forbidden') || message.includes('api key')) {
        return "configuration";
    }
  }

  return "unknown";
}

export function toErrorFamily(classification: FailureClassification): AdapterExecutionErrorFamily | null {
  switch (classification) {
    case "transient":
      return "transient_upstream";
    case "configuration":
    case "task":
    case "unknown":
      return null;
  }
}

export function summarizeJulesFailure(failure: JulesFailure): string {
    if (failure.message) return failure.message;
    if (failure.status) return `Jules Error: ${failure.status}`;
    if (failure.code) return `Jules Error Code: ${failure.code}`;
    return "Explicit Jules Failure";
}
