import { describe, expect, it } from "vitest";
import { evaluateAuthoritativeDependencies } from "../src/core/dependency-gate.js";

describe("authoritative dependency gate", () => {
  it.each([
    ["backlog", false],
    ["todo", false],
    ["in_progress", false],
    ["in_review", false],
    ["blocked", false],
    ["done", true],
    ["cancelled", true],
  ] as const)("allows dispatch only when blocker is terminal: %s", (status, safe) => {
    expect(evaluateAuthoritativeDependencies({
      blockedBy: [{ id: "blocker", status }],
    }).safe).toBe(safe);
  });

  it("fails closed when the enriched blocker projection is absent or malformed", () => {
    expect(evaluateAuthoritativeDependencies({}).safe).toBe(false);
    expect(evaluateAuthoritativeDependencies({ blockedBy: ["blocker"] }).safe).toBe(false);
    expect(evaluateAuthoritativeDependencies({ blockedBy: [{}] }).safe).toBe(false);
  });

  it("allows an issue with no persisted blockers", () => {
    expect(evaluateAuthoritativeDependencies({ blockedBy: [] })).toEqual({ safe: true });
  });
});
