import { describe, it, expect } from "vitest";
import { ANTIGRAVITY_MODELS, DEFAULT_ANTIGRAVITY_MODEL } from "../src/ui/models.js";
import { parseAntigravityStdoutLine } from "../src/ui/parse-stdout.js";

describe("Antigravity UI & Models", () => {
  it("exposes expected model catalog", () => {
    expect(ANTIGRAVITY_MODELS.length).toBeGreaterThan(0);
    expect(DEFAULT_ANTIGRAVITY_MODEL).toBe("gemini-pro-agent");
  });

  it("parses stdout line into transcript content entry", () => {
    const entries = parseAntigravityStdoutLine("Running tool git status", new Date().toISOString());
    expect(entries.length).toBe(1);
    expect((entries[0] as any).text).toBe("Running tool git status");
  });
});
