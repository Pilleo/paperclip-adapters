import { describe, it, expect } from "vitest";
import { resolveIssueLabels } from "../src/core/labels.js";

describe("Labels Module", () => {
  it("resolves canonical component and priority labels", () => {
    const labels = resolveIssueLabels({
      component: "enforcer",
      priority: "high",
      title: "Fix null pointer in BpfFilter",
    });

    const names = labels.map((l) => l.name);
    expect(names).toContain("component:enforcer");
    expect(names).toContain("priority:high");
    expect(names).toContain("type:bug");
  });

  it("assigns review label for non-interfering or review tasks", () => {
    const labels = resolveIssueLabels({
      component: "docs",
      priority: "low",
      isNonInterfering: true,
      title: "Update architecture docs",
    });

    const names = labels.map((l) => l.name);
    expect(names).toContain("component:docs");
    expect(names).toContain("priority:low");
    expect(names).toContain("type:review");
  });
});
