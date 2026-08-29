import { describe, it, expect } from "vitest";
import { VibeConfigSchema, DEFAULT_VIBE_COMMAND } from "../src/server/config.js";

describe("Vibe Adapter Config", () => {
  it("uses default values for empty config", () => {
    const config = VibeConfigSchema.parse({});
    expect(config.serverCommand).toBe(DEFAULT_VIBE_COMMAND);
    expect(config.thinking).toBe("high");
    expect(config.permissionMode).toBe("approve-all");
    expect(config.timeoutSec).toBe(300);
  });
});
