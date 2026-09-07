import { describe, expect, it } from "vitest";
import { canPromoteJulesPrToReview, isAuthoritativeJulesMonitor } from "../src/core/jules-monitor-state.js";

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

  it("allows recovery when only the stale executionState projection remains", () => {
    expect(canPromoteJulesPrToReview({
      ciGreen: true,
      currentHeadRejected: false,
      executionPolicy: undefined,
    })).toBe(true);
  });

  it("still blocks a rejected head or an authoritative provider monitor", () => {
    expect(canPromoteJulesPrToReview({ ciGreen: true, currentHeadRejected: true })).toBe(false);
    expect(canPromoteJulesPrToReview({
      ciGreen: true,
      currentHeadRejected: false,
      executionPolicy: { monitor: { serviceName: "jules", externalRef: "session-1" } },
    })).toBe(false);
  });
});
