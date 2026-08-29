import { describe, it, expect } from "vitest";
import { parseYamlFrontmatter } from "../src/core/backlog-sync.js";

describe("Backlog Sync Parser", () => {
  it("parses YAML frontmatter correctly", () => {
    const content = `---
id: "issue-123"
title: "Custom Title"
priority: high
target_files:
  - "src/A.kt"
---
# Description
Body content here.`;

    const parsed = parseYamlFrontmatter(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.fields.id).toBe("issue-123");
    expect(parsed!.fields.title).toBe("Custom Title");
    expect(parsed!.fields.priority).toBe("high");
    expect(parsed!.fields.target_files).toEqual(["src/A.kt"]);
    expect(parsed!.body).toContain("Body content here.");
  });

  it("returns null for non-frontmatter documents", () => {
    const parsed = parseYamlFrontmatter("# Just markdown\nNo frontmatter");
    expect(parsed).toBeNull();
  });
});
