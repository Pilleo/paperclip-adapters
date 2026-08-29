import { describe, it, expect } from "vitest";
import { testEnvironment } from "../src/server/test-environment.js";

describe("Antigravity testEnvironment", () => {
  it("validates accessible server binary and cwd", async () => {
    const result = await testEnvironment({
      companyId: "test-company",
      adapterType: "antigravity",
      config: {
        cwd: process.cwd(),
      },
    });

    expect(result.adapterType).toBe("antigravity");
    expect(result.checks.length).toBeGreaterThan(0);
    const serverCheck = result.checks.find((c) => c.code.startsWith("agy_server_"));
    expect(serverCheck).toBeDefined();
  });

  it("returns error for non-existent server binary path", async () => {
    const result = await testEnvironment({
      companyId: "test-company",
      adapterType: "antigravity",
      config: {
        serverPath: "/non/existent/agy_acp_server.par",
      },
    });

    expect(result.status).toBe("fail");
    const check = result.checks.find((c) => c.code === "agy_server_missing_or_not_executable");
    expect(check?.level).toBe("error");
  });
});
