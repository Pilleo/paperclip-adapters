import { describe, it, expect } from "vitest";
import { AntigravityConfigSchema, DEFAULT_AGY_SERVER_PATH } from "../src/server/config.js";

describe("Antigravity Adapter Config", () => {
  it("uses default values for empty config", () => {
    const config = AntigravityConfigSchema.parse({});
    expect(config.serverPath).toBe(DEFAULT_AGY_SERVER_PATH);
    expect(config.debug).toBe(false);
    expect(config.permissionMode).toBe("approve-all");
    expect(config.timeoutSec).toBe(300);
  });

  it("parses custom configuration", () => {
    const config = AntigravityConfigSchema.parse({
      serverPath: "/custom/path/agy.par",
      debug: true,
      model: "gemini-2.5-pro",
    });
    expect(config.serverPath).toBe("/custom/path/agy.par");
    expect(config.debug).toBe(true);
    expect(config.model).toBe("gemini-2.5-pro");
  });
});
