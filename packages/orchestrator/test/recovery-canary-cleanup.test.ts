import { describe, expect, it } from "vitest";
import * as canaryState from "../src/core/recovery-canary-state.js";

type CleanupFailureFactory = (operationError: unknown, cleanupError: unknown, companyId: string) => Error;
const { combineRecoveryCanaryFailure } = canaryState as unknown as {
  readonly combineRecoveryCanaryFailure: CleanupFailureFactory;
};

describe("combineRecoveryCanaryFailure", () => {
  it("preserves both operation and cleanup failures", () => {
    expect(combineRecoveryCanaryFailure).toBeTypeOf("function");
    const operationError = new Error("operation failed");
    const cleanupError = new Error("company deletion returned HTTP 500");
    const combined = combineRecoveryCanaryFailure(operationError, cleanupError, "company-1");
    expect(combined).toBeInstanceOf(AggregateError);
    expect((combined as AggregateError).errors).toEqual([operationError, cleanupError]);
    expect(combined.message).toContain("company-1");
  });
});
