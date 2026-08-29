import { describe, it, expect } from "vitest";
import { archiveResolvedBacklogFiles, rebuildBacklogReadme } from "../src/core/backlog-archiver.js";
import { ParsedIssueMetadata } from "../src/core/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Backlog Archiver & README Indexer", () => {
  it("archives done issues into resolved/ and updates README.md", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archiver-test-"));
    const backlogDir = path.join(tmpDir, "docs/internals/backlog");
    fs.mkdirSync(backlogDir, { recursive: true });

    const openIssueContent = `---
title: "Still Open Task"
identifier: "MAZ-100"
status: "open"
priority: "high"
component: "enforcer"
---
# Context`;

    const doneIssueContent = `---
title: "Completed Task"
identifier: "MAZ-101"
status: "done"
priority: "medium"
component: "profiler"
---
# Context`;

    fs.writeFileSync(path.join(backlogDir, "issue-100.md"), openIssueContent);
    fs.writeFileSync(path.join(backlogDir, "issue-101.md"), doneIssueContent);

    const mockIssues: ParsedIssueMetadata[] = [
      {
        id: "issue-100",
        identifier: "MAZ-100",
        title: "Still Open Task",
        status: "todo",
        priority: "high",
        priorityRank: 3,
        component: "enforcer",
        targetFiles: [],
        targetModules: [],
        targetSymbols: [],
        dependencies: [],
        hasSideEffects: false,
        isNonInterfering: false,
        rawIssue: {},
      },
      {
        id: "issue-101",
        identifier: "MAZ-101",
        title: "Completed Task",
        status: "done",
        priority: "medium",
        priorityRank: 2,
        component: "profiler",
        targetFiles: [],
        targetModules: [],
        targetSymbols: [],
        dependencies: [],
        hasSideEffects: false,
        isNonInterfering: false,
        rawIssue: {},
      },
    ];

    const result = archiveResolvedBacklogFiles(tmpDir, mockIssues);
    expect(result.archivedCount).toBe(1);
    expect(result.archivedFiles).toContain("issue-101.md");

    const resolvedFile = path.join(backlogDir, "resolved/issue-101.md");
    expect(fs.existsSync(resolvedFile)).toBe(true);

    const remainingFile = path.join(backlogDir, "issue-100.md");
    expect(fs.existsSync(remainingFile)).toBe(true);

    const readme = fs.readFileSync(path.join(backlogDir, "README.md"), "utf-8");
    expect(readme).toContain("Total Active Issues:* 1");
    expect(readme).toContain("Total Resolved Issues:* 1");
    expect(readme).toContain("MAZ-100");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles empty or missing backlog directories gracefully", () => {
    const res = archiveResolvedBacklogFiles("/non/existent/path", []);
    expect(res.archivedCount).toBe(0);
    expect(res.archivedFiles.length).toBe(0);
  });
});
