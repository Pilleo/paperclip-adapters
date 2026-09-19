import { describe, expect, it } from "vitest";
import { classifyJulesPrReviewDisposition, hasJulesMonitorClaim, isAuthoritativeJulesMonitor } from "../src/core/jules-monitor-state.js";

describe("Jules monitor authority", () => {
  it("accepts a Jules monitor stored in executionPolicy", () => {
    expect(isAuthoritativeJulesMonitor({ monitor: { serviceName: "jules", externalRef: "session-1" } })).toBe(true);
  });

  it("rejects the residual executionState projection", () => {
    expect(isAuthoritativeJulesMonitor(undefined)).toBe(false);
  });

  it("rejects incomplete or non-Jules monitors", () => {
    expect(isAuthoritativeJulesMonitor({ monitor: { serviceName: "jules" } })).toBe(false);
    expect(isAuthoritativeJulesMonitor({ monitor: { serviceName: "vibe", externalRef: "session-1" } })).toBe(false);
  });

  it.each([
    ["durable policy", { executionPolicy: { monitor: { serviceName: "jules", externalRef: "session-1" } } }, true],
    ["redacted native projection", { executionState: { monitor: { serviceName: "jules", externalRef: "[redacted]", status: "triggered" } } }, true],
    ["different provider", { executionState: { monitor: { serviceName: "github", externalRef: "pr-1" } } }, false],
    ["malformed state", { executionState: { monitor: "jules" } }, false],
  ] as const)("classifies the %s monitor ownership claim", (_label, input, expected) => {
    expect(hasJulesMonitorClaim(input)).toBe(expected);
  });

  it("classifies a clear provider state as eligible for PR review", () => {
    expect(classifyJulesPrReviewDisposition({
      currentHeadRejected: false,
      executionPolicy: undefined,
    })).toEqual({ kind: "eligible_for_review" });
  });

  it("keeps a Jules-owned PR with an authoritative provider monitor", () => {
    expect(classifyJulesPrReviewDisposition({
      currentHeadRejected: false,
      executionPolicy: { monitor: { serviceName: "jules", externalRef: "session-1" } },
    })).toEqual({ kind: "await_provider" });
  });

  it("recovers a rejected PR whose provider monitor was lost", () => {
    expect(classifyJulesPrReviewDisposition({
      currentHeadRejected: true,
      executionPolicy: undefined,
    })).toEqual({ kind: "recover_provider" });
  });
});
