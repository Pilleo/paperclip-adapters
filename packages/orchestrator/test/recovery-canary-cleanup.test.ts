import { describe, expect, it } from "vitest";
import {
  combineRecoveryCanaryFailure,
  shouldUseOwnedRecoveryCanaryCleanup,
} from "../src/core/recovery-canary-state.js";

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

describe("shouldUseOwnedRecoveryCanaryCleanup", () => {
  it("permits whole-state teardown only for an explicitly owned loopback server", () => {
    expect(shouldUseOwnedRecoveryCanaryCleanup({
      ownsServerState: true,
      apiUrl: "http://127.0.0.1:3100",
      dataDirectory: "/tmp/paperclip-canary",
    })).toBe(true);
    expect(shouldUseOwnedRecoveryCanaryCleanup({
      ownsServerState: false,
      apiUrl: "http://127.0.0.1:3100",
      dataDirectory: "/tmp/paperclip-canary",
    })).toBe(false);
    expect(shouldUseOwnedRecoveryCanaryCleanup({
      ownsServerState: true,
      apiUrl: "https://paperclip.example.test",
      dataDirectory: "/tmp/paperclip-canary",
    })).toBe(false);
    expect(shouldUseOwnedRecoveryCanaryCleanup({
      ownsServerState: true,
      apiUrl: "http://localhost:3100",
      dataDirectory: "relative-canary-data",
    })).toBe(false);
  });
});
