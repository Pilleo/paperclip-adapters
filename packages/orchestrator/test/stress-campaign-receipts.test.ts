import { describe, expect, it } from "vitest";
import { buildStressIssue, stressTasks } from "../src/core/stress-campaign-manifest.js";
import { assertStressReadback, selectStressProject, stressIssueDecision } from "../src/core/stress-campaign-receipts.js";

const key = "stress-20260929-a";
const task = stressTasks(key)[6]!;
const expected = buildStressIssue(task, "project-1", ["first-issue"]);
const detail = { id: "issue-7", ...expected, blockedBy: [{ id: "first-issue" }] };

describe("journaled stress campaign readbacks", () => {
  it("selects only the unique run-marked project and rejects ambiguous projects", () => {
    const marker = "<!-- paperclip-adapters:stress-project:v1 -->";
    expect(selectStressProject([], key).kind).toBe("missing");
    expect(selectStressProject([{ id: "old", description: "<!-- paperclip-adapters:e2e-project:v2 -->" }], key).kind).toBe("missing");
    expect(selectStressProject([{ id: "one", name: `Stress [stress:${key}]`, description: marker }], key))
      .toEqual({ kind: "found", project: { id: "one", name: `Stress [stress:${key}]`, description: marker } });
    expect(selectStressProject([{ id: "one", name: "Other stress", description: marker }], key).kind).toBe("invalid");
    expect(selectStressProject(Array.from({ length: 2 }, (_, i) => ({ id: `${i}`, name: `Stress [stress:${key}]`, description: marker })), key).kind).toBe("invalid");
  });

  it("resumes one exactly matching issue but never reposts an uncertain or conflicting result", () => {
    expect(stressIssueDecision([], task, expected)).toEqual({ kind: "create" });
    expect(stressIssueDecision([detail], task, expected)).toEqual({ kind: "resume", issueId: "issue-7" });
    expect(stressIssueDecision([{ ...detail, status: "todo" }], task, expected, "either"))
      .toEqual({ kind: "resume", issueId: "issue-7" });
    expect(stressIssueDecision([{ ...detail, status: "in_progress" }], task, expected, "either").kind).toBe("stop");
    expect(stressIssueDecision([detail, { ...detail, id: "duplicate" }], task, expected).kind).toBe("stop");
    expect(stressIssueDecision([{ ...detail, projectId: "wrong" }], task, expected).kind).toBe("stop");
    expect(stressIssueDecision([{ ...detail, blockedBy: [] }], task, expected).kind).toBe("stop");
  });

  it("rejects changed immutable descriptions, non-backlog tasks and native blockers with missing IDs", () => {
    expect(() => assertStressReadback(task, expected, detail)).not.toThrow();
    expect(() => assertStressReadback(task, expected, { ...detail, description: "changed" })).toThrow();
    expect(() => assertStressReadback(task, expected, { ...detail, status: "todo" })).toThrow();
    expect(() => assertStressReadback(task, expected, { ...detail, blockedBy: [{ id: "wrong" }] })).toThrow();
  });
});
