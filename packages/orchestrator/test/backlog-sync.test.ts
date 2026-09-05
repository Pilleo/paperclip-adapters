import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYamlFrontmatter, resolveBacklogIssueCandidates, syncBacklogMarkdownToPaperclip } from "../src/core/backlog-sync.js";

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

  it("does not guess when multiple active issues share the canonical title", () => {
    const result = resolveBacklogIssueCandidates(
      [
        { id: "issue-822", title: "[issue-x] Same" },
        { id: "issue-833", title: "[issue-x] Same" },
      ],
      undefined,
      "[issue-x] Same",
    );
    expect(result.issue).toBeUndefined();
    expect(result.candidates.map((issue) => issue.id)).toEqual(["issue-822", "issue-833"]);
  });

  it("uses the declared Paperclip id as the authoritative identity", () => {
    const result = resolveBacklogIssueCandidates(
      [
        { id: "issue-822", title: "[issue-x] Same" },
        { id: "issue-833", title: "[issue-x] Same" },
      ],
      "issue-833",
      "[issue-x] Same",
    );
    expect(result.issue?.id).toBe("issue-833");
  });
});
