import { describe, expect, it } from "vitest";
import { OrchestratorConfigSchema } from "../src/server/index.js";

describe("orchestrator configuration", () => {
  it("rejects unsupported observe mode rather than implying a shadow reconciler exists", () => {
    expect(() => OrchestratorConfigSchema.parse({ reconciliationMode: "observe" })).toThrow();
  });

  it("accepts freeze as the explicit zero-contact safety mode", () => {
    expect(OrchestratorConfigSchema.parse({ reconciliationMode: "freeze" }).reconciliationMode).toBe("freeze");
  });
});
