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

  it("reconciles the source description and claims an unassigned managed backlog issue", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-sync-"));
    const backlog = path.join(root, "docs/internals/backlog/testing");
    fs.mkdirSync(backlog, { recursive: true });
    const filePath = path.join(backlog, "issue-test-description.md");
    const source = `---
id: "issue-test-description"
title: "Managed task"
status: "open"
priority: high
orchestrator_managed: true
target_modules:
  - "packages/orchestrator"
paperclip_issue_id: "paperclip-issue"
paperclip_identifier: "MAZ-999"
---

Updated source contract.
`;
    fs.writeFileSync(filePath, source);

    const originalFetch = globalThis.fetch;
    const patches: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      }
      expect(url).toBe("http://paperclip.test/api/companies/company-1/issues?limit=2000");
      return new Response(JSON.stringify([{
        id: "paperclip-issue",
        identifier: "MAZ-999",
        title: "[issue-test-description] Managed task",
        description: "old source contract",
        status: "backlog",
        assigneeAgentId: null,
        projectId: "project-1",
      }]), { status: 200 });
    }) as typeof fetch;

    try {
      const summary = await syncBacklogMarkdownToPaperclip({
        workspacePath: root,
        companyId: "company-1",
        apiUrl: "http://paperclip.test",
        projectId: "project-1",
        orchestratorAgentId: "orchestrator-1",
      });

      expect(summary.updatedCount).toBe(2);
      expect(patches).toEqual([
        { description: expect.stringContaining("Updated source contract.") },
        { status: "backlog", assigneeAgentId: "orchestrator-1" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
