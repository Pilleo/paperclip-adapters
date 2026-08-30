import { describe, expect, it } from "vitest";
import { LOCAL_AGENT_TOOL_GUIDANCE, withLocalAgentToolBudget } from "../src/local-agent-tools.js";

describe("local agent tool budget", () => {
  it("prepends Codanna/diff/test guidance to task markdown", () => {
    const next = withLocalAgentToolBudget({ paperclipTaskMarkdown: "Fix the leak." });
    expect(String(next.paperclipTaskMarkdown)).toContain("codanna retrieve describe");
    expect(String(next.paperclipTaskMarkdown)).toContain("git diff");
    expect(String(next.paperclipTaskMarkdown)).toContain("Fix the leak.");
    expect(LOCAL_AGENT_TOOL_GUIDANCE).not.toContain("Jules");
  });

  it("still injects guidance when the task has no description yet", () => {
    const next = withLocalAgentToolBudget({ extra: 1 });
    expect(String(next.paperclipTaskMarkdown)).toContain("codanna retrieve describe");
    expect(String(next.description)).toContain("Prefer `git diff`");
    expect(next.extra).toBe(1);
  });
});
