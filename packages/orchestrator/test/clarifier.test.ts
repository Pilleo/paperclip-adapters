import { describe, it, expect } from "vitest";
import {
  needsClarification,
  selectClarificationCandidates,
  isTaskTooBroad,
  buildClarifierAutonomousPrompt,
} from "../src/core/clarifier.js";
import { extractIssueMetadata } from "../src/core/parser.js";

describe("Clarifier Module", () => {
  it("detects issues with open_questions: true", () => {
    const issue = extractIssueMetadata({
      id: "issue-1",
      title: "Ambiguous spec",
      status: "backlog",
      description: "---\nopen_questions: true\n---\nNeed clarification.",
    });
    expect(needsClarification(issue)).toBe(true);
  });

  it("detects issues with non-empty open questions markdown section", () => {
    const issue = extractIssueMetadata({
      id: "issue-2",
      title: "Spec with open questions",
      status: "backlog",
      description: "## ❓ Open Questions\n1. Should we support ARM64?\n2. What is the fallback behavior?",
    });
    expect(needsClarification(issue)).toBe(true);
  });

  it("passes clarified issues with explicit target files", () => {
    const issue = extractIssueMetadata({
      id: "issue-3",
      title: "Crystal clear bugfix",
      status: "backlog",
      description: "---\ntarget_files: [src/Bpf.kt]\n---\nFix typo.",
    });
    expect(needsClarification(issue)).toBe(false);
  });

  it("detects when a task is too broad (cross-module sprawl or multi-phase epic)", () => {
    const broadIssue = extractIssueMetadata({
      id: "issue-broad",
      title: "Massive Monolithic Epic",
      status: "backlog",
      description: `---
target_files:
  - enforcer/src/A.kt
  - profiler/src/B.kt
  - tools/orchestrator/src/C.kt
  - platform/src/D.kt
  - cli/src/E.kt
  - core/src/F.kt
---
Part 1: Refactor all types
Part 2: Rewrite FFM engine
Part 3: Rewrite CLI`,
    });

    const check = isTaskTooBroad(broadIssue);
    expect(check.isTooBroad).toBe(true);
    expect(check.reason).toBeDefined();
    expect(needsClarification(broadIssue)).toBe(true);

    const prompt = buildClarifierAutonomousPrompt(broadIssue);
    expect(prompt).toContain("SCOPE ALERT");
    expect(prompt).toContain("Task Granularity & Atomicity Verification");
  });

  it("selects candidates for Vibe clarifier lane", () => {
    const issueA = extractIssueMetadata({
      id: "issue-a",
      title: "Task A",
      priority: "high",
      status: "backlog",
      description: "---\nopen_questions: true\n---",
    });
    const issueB = extractIssueMetadata({
      id: "issue-b",
      title: "Task B",
      priority: "low",
      status: "backlog",
      description: "---\nopen_questions: true\n---",
    });

    const candidates = selectClarificationCandidates([issueB, issueA], "vibe-agent-id", 1);
    expect(candidates.length).toBe(1);
    expect(candidates[0].issue.id).toBe("issue-a"); // Higher priority ranked first
    expect(candidates[0].targetAgentId).toBe("vibe-agent-id");
  });
});
