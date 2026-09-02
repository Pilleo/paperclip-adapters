import { describe, expect, it } from "vitest";
import {
  createCapabilitySnapshot,
  decideMutationMode,
  type CapabilitySnapshot,
} from "../src/paperclip-capabilities.js";

describe("Paperclip capability model", () => {
  it("normalizes a complete capability response", () => {
    const snapshot = createCapabilitySnapshot({
      version: "2026.900.0",
      capabilities: {
        continuationWakeup: true,
        activityCursor: false,
        pluginState: "supported",
      },
    });

    expect(snapshot).toEqual({
      hostVersion: "2026.900.0",
      capabilities: {
        continuationWakeup: "supported",
        activityCursor: "unsupported",
        pluginState: "supported",
      },
    });
  });

  it("treats malformed and absent capabilities as unknown", () => {
    const snapshot = createCapabilitySnapshot({ capabilities: { pluginState: "maybe" } });
    expect(snapshot.capabilities.pluginState).toBe("unknown");
    expect(snapshot.capabilities.continuationWakeup).toBe("unknown");
  });

  it("fails closed for mutations when capability is unknown", () => {
    const snapshot: CapabilitySnapshot = {
      hostVersion: undefined,
      capabilities: { continuationWakeup: "unknown", activityCursor: "unknown", pluginState: "unknown" },
    };
    expect(decideMutationMode(snapshot, "continuationWakeup")).toBe("legacy");
    expect(decideMutationMode(snapshot, "pluginState")).toBe("reject");
  });

  it("uses native mode only for positively supported capabilities", () => {
    expect(decideMutationMode({
      hostVersion: "2026.900.0",
      capabilities: { continuationWakeup: "supported", activityCursor: "unknown", pluginState: "unknown" },
    }, "continuationWakeup")).toBe("native");
  });
});
