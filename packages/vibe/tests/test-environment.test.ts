import { describe, it, expect } from "vitest";
import { testEnvironment } from "../src/server/test-environment.js";

describe("Vibe testEnvironment", () => {
  it("validates accessible vibe-acp executable and cwd", async () => {
    const result = await testEnvironment({
      companyId: "test-company",
      adapterType: "vibe",
      config: {
        cwd: process.cwd(),
      },
    });

    expect(result.adapterType).toBe("vibe");
    expect(result.checks.length).toBeGreaterThan(0);
  });
});
