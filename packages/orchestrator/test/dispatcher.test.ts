import { describe, it, expect } from "vitest";
import { extractIssueMetadata } from "../src/core/parser.js";
import { calculateConflictMatrix, selectNextTasks, selectNextTasksMultiLane } from "../src/core/dispatcher.js";

describe("Deterministic Orchestrator Dispatcher Engine", () => {
  it("extracts YAML frontmatter metadata and handles multiline lists", () => {
    const rawIssue = {
      id: "issue-1",
      identifier: "MAZ-101",
      title: "Fix BPF Filter Downcall",
      status: "backlog",
      description: `---
priority: high
component: "enforcer"
target_modules:
  - ":enforcer"
target_files:
  - "enforcer/src/main/kotlin/io/mazewall/BpfFilter.kt"
target_symbols:
  - "BpfFilter.install"
dependencies:
  - "MAZ-100"
---
# Details
Fixing BPF layout.`,
    };

    const parsed = extractIssueMetadata(rawIssue);
    expect(parsed.priority).toBe("high");
    expect(parsed.priorityRank).toBe(3);
    expect(parsed.targetFiles).toEqual(["enforcer/src/main/kotlin/io/mazewall/BpfFilter.kt"]);
    expect(parsed.targetSymbols).toEqual(["BpfFilter.install"]);
    expect(parsed.dependencies).toEqual(["MAZ-100"]);
  });

  it("calculates conflict edges on shared files and blocks lower priority task", () => {
    const highTask = extractIssueMetadata({
      id: "task-high",
      identifier: "MAZ-1",
      title: "High Priority Task",
      status: "backlog",
      priority: "high",
      description: `---
priority: high
target_files: ["enforcer/src/main/kotlin/io/mazewall/BpfFilter.kt"]
---`,
    });

    const lowTask = extractIssueMetadata({
      id: "task-low",
      identifier: "MAZ-2",
      title: "Low Priority Task",
      status: "backlog",
      priority: "low",
      description: `---
priority: low
target_files: ["enforcer/src/main/kotlin/io/mazewall/BpfFilter.kt"]
---`,
    });

    const matrix = calculateConflictMatrix([highTask, lowTask]);
    expect(matrix.blockedByMap.get("task-low")).toEqual(["task-high"]);
    expect(matrix.blockedByMap.get("task-high")).toEqual([]);

    const selected = selectNextTasks([highTask, lowTask], matrix, { maxConcurrent: 1 });
    expect(selected.length).toBe(1);
    expect(selected[0].issue.id).toBe("task-high");
  });

  it("unblocks dependent task when blocker is done", () => {
    const blocker = extractIssueMetadata({
      id: "task-blocker",
      identifier: "MAZ-1",
      title: "Blocker Task",
      status: "done",
      priority: "high",
      description: `---
priority: high
target_files: ["enforcer/src/main/kotlin/io/mazewall/BpfFilter.kt"]
---`,
    });

    const blocked = extractIssueMetadata({
      id: "task-blocked",
      identifier: "MAZ-2",
      title: "Blocked Task",
      status: "backlog",
      priority: "medium",
      description: `---
priority: medium
target_files: ["enforcer/src/main/kotlin/io/mazewall/BpfFilter.kt"]
---`,
    });

    const matrix = calculateConflictMatrix([blocker, blocked]);
    const selected = selectNextTasks([blocker, blocked], matrix, { maxConcurrent: 1 });
    expect(selected.length).toBe(1);
    expect(selected[0].issue.id).toBe("task-blocked");
  });
});

describe("Multi-Lane Concurrency & Jules Quota Selection", () => {
  it("dispatches up to Jules capacity across non-colliding tasks", () => {
    const task1 = extractIssueMetadata({
      id: "task-1",
      title: "Task 1",
      status: "backlog",
      description: "---\npriority: high\ntarget_files:\n  - fileA.kt\n---",
    });
    const task2 = extractIssueMetadata({
      id: "task-2",
      title: "Task 2",
      status: "backlog",
      description: "---\npriority: medium\ntarget_files:\n  - fileB.kt\n---",
    });
    const task3 = extractIssueMetadata({
      id: "task-3",
      title: "Task 3 (Collides with 1)",
      status: "backlog",
      description: "---\npriority: low\ntarget_files:\n  - fileA.kt\n---",
    });

    const matrix = calculateConflictMatrix([task1, task2, task3]);
    const selections = selectNextTasksMultiLane([task1, task2, task3], matrix, {
      julesAgentId: "agent-jules",
      julesCapacity: 5,
      julesRunningCount: 0,
      maxToSelect: 5,
    });

    // Should select task1 and task2, but skip task3 due to collision with task1
    expect(selections.length).toBe(2);
    expect(selections.map((s) => s.issue.id)).toEqual(["task-1", "task-2"]);
    expect(selections.every((s) => s.targetAgentId === "agent-jules")).toBe(true);
  });
});

describe("Method-level granularity conflict evaluation", () => {
  it("allows concurrent scheduling for disjoint method targets in the same file", () => {
    const taskA: ParsedIssueMetadata = {
      id: "task-a",
      title: "Add ARM64 downcall",
      status: "todo",
      priority: "high",
      priorityRank: 3,
      dependencies: [],
      targetFiles: ["enforcer/src/BpfFilter.kt"],
      targetModules: [":enforcer"],
      targetSymbols: ["BpfFilter#compileArm64"],
      hasSideEffects: false,
      isNonInterfering: false,
      rawIssue: {},
    };

    const taskB: ParsedIssueMetadata = {
      id: "task-b",
      title: "Add X86 downcall",
      status: "todo",
      priority: "high",
      priorityRank: 3,
      dependencies: [],
      targetFiles: ["enforcer/src/BpfFilter.kt"],
      targetModules: [":enforcer"],
      targetSymbols: ["BpfFilter#compileX86_64"],
      hasSideEffects: false,
      isNonInterfering: false,
      rawIssue: {},
    };

    const matrix = calculateConflictMatrix([taskA, taskB]);
    expect(matrix.conflictEdges).toHaveLength(0);

    const selected = selectNextTasks([taskA, taskB], matrix, { julesCapacity: 2 });
    expect(selected).toHaveLength(2);
  });

  it("blocks concurrent scheduling if method targets overlap", () => {
    const taskA: ParsedIssueMetadata = {
      id: "task-a",
      title: "Refactor compile",
      status: "in_progress",
      priority: "high",
      priorityRank: 3,
      dependencies: [],
      targetFiles: ["enforcer/src/BpfFilter.kt"],
      targetModules: [":enforcer"],
      targetSymbols: ["BpfFilter#compile"],
      hasSideEffects: false,
      isNonInterfering: false,
      rawIssue: {},
    };

    const taskB: ParsedIssueMetadata = {
      id: "task-b",
      title: "Optimize compile",
      status: "todo",
      priority: "high",
      priorityRank: 3,
      dependencies: [],
      targetFiles: ["enforcer/src/BpfFilter.kt"],
      targetModules: [":enforcer"],
      targetSymbols: ["BpfFilter#compile"],
      hasSideEffects: false,
      isNonInterfering: false,
      rawIssue: {},
    };

    const matrix = calculateConflictMatrix([taskA, taskB]);
    expect(matrix.conflictEdges).toHaveLength(1);
    expect(matrix.conflictEdges[0]?.reason).toContain("Shared method/symbol targets");
  });
});

describe("Blocker ID normalization", () => {
  it("normalizes fully qualified paperclip URIs to UUIDs and blocks dependents", () => {
    const depTask: ParsedIssueMetadata = {
      id: "uuid-1234-5678-0000-0000-0000-000000000000",
      identifier: "MAZ-200",
      title: "Dep task",
      status: "todo",
      priority: "high",
      priorityRank: 3,
      dependencies: [],
      targetFiles: [],
      targetModules: [],
      targetSymbols: [],
      hasSideEffects: false,
      isNonInterfering: false,
      rawIssue: {},
    };

    const task: ParsedIssueMetadata = {
      id: "task-2",
      title: "Blocked task",
      status: "todo",
      priority: "high",
      priorityRank: 3,
      dependencies: ["paperclip://uuid-1234-5678-0000-0000-0000-000000000000"],
      targetFiles: [],
      targetModules: [],
      targetSymbols: [],
      hasSideEffects: false,
      isNonInterfering: false,
      rawIssue: {},
    };

    const matrix = calculateConflictMatrix([depTask, task]);
    expect(matrix.conflictEdges).toHaveLength(1);
    expect(matrix.conflictEdges[0]?.issueId1).toBe("uuid-1234-5678-0000-0000-0000-000000000000");
    expect(matrix.conflictEdges[0]?.issueId2).toBe("task-2");

    const selected = selectNextTasks([depTask, task], matrix, { julesCapacity: 2 });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.issue.id).toBe("uuid-1234-5678-0000-0000-0000-000000000000");
  });
});
