import { describe, it, expect } from "vitest";
import {
  parseMarkdownFrontmatter,
  serializeMarkdownFrontmatter,
  toComponentLabel,
  parseComponentFromLabel,
  toPriorityLabel,
  parsePriorityFromLabel,
  redactSensitiveData,
  generateBacklogFilename,
  parseBacklogFilename,
} from "../src/index.js";

describe("Frontmatter Parser", () => {
  it("parses valid yaml frontmatter and markdown body", () => {
    const raw = `---
title: "Fix bug"
severity: "HIGH"
priority: high
component: "enforcer"
---

# Title
Body text here.
`;
    const res = parseMarkdownFrontmatter<{ title: string; severity: string; priority: string; component: string }>(raw);
    expect(res.hasFrontmatter).toBe(true);
    expect(res.frontmatter.title).toBe("Fix bug");
    expect(res.frontmatter.severity).toBe("HIGH");
    expect(res.content).toContain("# Title");
  });

  it("handles markdown without frontmatter gracefully", () => {
    const raw = "# Just a markdown file";
    const res = parseMarkdownFrontmatter(raw);
    expect(res.hasFrontmatter).toBe(false);
    expect(res.content).toBe("# Just a markdown file");
  });

  it("serializes frontmatter and content symmetrically", () => {
    const obj = { title: "Hello", priority: "high" };
    const content = "Hello world body";
    const serialized = serializeMarkdownFrontmatter(obj, content);
    const parsed = parseMarkdownFrontmatter(serialized);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter).toEqual(obj);
    expect(parsed.content).toBe(content);
  });
});

describe("Labels & Metadata", () => {
  it("converts component to canonical label and back", () => {
    expect(toComponentLabel("Enforcer")).toBe("component:enforcer");
    expect(parseComponentFromLabel("component:enforcer")).toBe("enforcer");
    expect(parseComponentFromLabel("other:label")).toBeUndefined();
  });

  it("converts priority to canonical label and back", () => {
    expect(toPriorityLabel("HIGH")).toBe("priority:high");
    expect(parsePriorityFromLabel("priority:high")).toBe("high");
    expect(parsePriorityFromLabel("priority:invalid")).toBeUndefined();
  });
});

describe("Sensitive Data Sanitizer", () => {
  it("redacts Google AI Studio and GitHub API keys", () => {
    const text = "Error with key AIzaSyA12345678901234567890123456789012 and ghp_123456789012345678901234567890123456";
    const cleaned = redactSensitiveData(text);
    expect(cleaned).not.toContain("AIzaSy");
    expect(cleaned).not.toContain("ghp_");
    expect(cleaned).toContain("[REDACTED]");
  });

  it("redacts basic auth from URLs", () => {
    const url = "https://user:secretpass@github.com/Pilleo/mazewall.git";
    const cleaned = redactSensitiveData(url);
    expect(cleaned).toBe("https://user:[REDACTED]@github.com/Pilleo/mazewall.git");
  });
});

describe("Backlog File Naming", () => {
  it("generates deterministic timestamped backlog filenames", () => {
    const date = new Date("2026-08-29T12:30:45.000Z");
    const filename = generateBacklogFilename("Cap SandboxDispatcher Pool Cache", date);
    expect(filename).toBe("issue-20260829-123045-cap-sandboxdispatcher-pool-cache.md");

    const parsed = parseBacklogFilename(filename);
    expect(parsed?.timestamp).toBe("20260829-123045");
    expect(parsed?.slug).toBe("cap-sandboxdispatcher-pool-cache");
  });
});
