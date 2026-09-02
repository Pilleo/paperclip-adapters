import { describe, expect, it } from "vitest";
import { isProjectWorkspaceDirectory, partitionIssuesByProject } from "../src/core/project-workspaces.js";
import type { PaperclipProjectRecord } from "../src/core/parser.js";

const projects: PaperclipProjectRecord[] = [
  {
    id: "project-a",
    name: "A",
    primaryWorkspace: { cwd: "/tmp/project-a" },
  },
  {
    id: "project-b",
    name: "B",
    codebase: { effectiveLocalFolder: "/tmp/project-b" },
  },
];

describe("partitionIssuesByProject", () => {
  it("recognizes an existing directory and rejects a missing checkout", () => {
    expect(isProjectWorkspaceDirectory(process.cwd())).toBe(true);
    expect(isProjectWorkspaceDirectory("/path/that/does/not/exist")).toBe(false);
  });

  it("creates independent workspace groups from issue project ids", () => {
    const result = partitionIssuesByProject({
      projects,
      issues: [
        { id: "a-1", projectId: "project-a" },
        { id: "b-1", projectId: "project-b" },
        { id: "a-2", projectId: "project-a" },
      ],
    });

    expect(result.groups).toEqual([
      {
        project: projects[0],
        workspacePath: "/tmp/project-a",
        issues: [{ id: "a-1", projectId: "project-a" }, { id: "a-2", projectId: "project-a" }],
      },
      {
        project: projects[1],
        workspacePath: "/tmp/project-b",
        issues: [{ id: "b-1", projectId: "project-b" }],
      },
    ]);
  });

  it("rejects project-less and unknown-project issues without a fallback workspace", () => {
    const result = partitionIssuesByProject({
      projects,
      issues: [
        { id: "missing", projectId: null },
        { id: "unknown", projectId: "project-c" },
      ],
    });

    expect(result.groups).toHaveLength(0);
    expect(result.rejected.map(({ issue, resolution }) => [issue.id, resolution.reason])).toEqual([
      ["missing", "missing-project"],
      ["unknown", "unknown-project"],
    ]);
  });

  it("does not share a group when two projects point at the same-looking folder name", () => {
    const result = partitionIssuesByProject({
      projects: [
        { id: "one", name: "repo", primaryWorkspace: { cwd: "/tmp/one/repo" } },
        { id: "two", name: "repo", primaryWorkspace: { cwd: "/tmp/two/repo" } },
      ],
      issues: [{ id: "one-issue", projectId: "one" }, { id: "two-issue", projectId: "two" }],
    });

    expect(result.groups.map((group) => group.workspacePath)).toEqual(["/tmp/one/repo", "/tmp/two/repo"]);
  });
});
