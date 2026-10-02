import { describe, expect, it } from "vitest";
import { OrchestratorConfigSchema } from "../src/server/index.js";

describe("orchestrator configuration", () => {
  it("rejects unsupported observe mode rather than implying a shadow reconciler exists", () => {
    expect(() => OrchestratorConfigSchema.parse({ reconciliationMode: "observe" })).toThrow();
  });

  it("accepts freeze as the explicit zero-contact safety mode", () => {
    expect(OrchestratorConfigSchema.parse({ reconciliationMode: "freeze" }).reconciliationMode).toBe("freeze");
  });

  it("defaults conflict recovery to manual even with a historical worker or stored resolver", () => {
    for (const config of [{}, { vibeAgentId: "old-worker" }, { conflictRecoveryAgentId: "chosen" }]) {
      expect(OrchestratorConfigSchema.parse(config)).toMatchObject({ conflictRecoveryMode: "manual" });
    }
  });

  it.each(["manual", "git_only", "agent"])("retains the configured conflict recovery mode %s", (mode) => {
    expect(OrchestratorConfigSchema.parse({ conflictRecoveryMode: mode, conflictRecoveryAgentId: "chosen" }))
      .toMatchObject({ conflictRecoveryMode: mode, conflictRecoveryAgentId: "chosen" });
  });

  it.each([
    { conflictRecoveryMode: "automatic" },
    { conflictRecoveryMode: null },
    { conflictRecoveryMode: "agent" },
    { conflictRecoveryMode: "agent", conflictRecoveryAgentId: "  " },
    { conflictRecoveryAgentId: 12 },
  ])("rejects invalid conflict recovery configuration %j", (config) => {
    expect(OrchestratorConfigSchema.safeParse(config).success).toBe(false);
  });
});
