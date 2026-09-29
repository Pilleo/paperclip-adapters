import { describe, expect, it } from "vitest";
import { buildStressIssue, stressTasks, validateStressTasks } from "../src/core/stress-campaign-manifest.js";

const runKey = "stress-20260929-a";

describe("disposable stress campaign manifest", () => {
  it("defines 20 ordered tasks, six roots, chain, diamond, join and a single intended file collision", () => {
    const tasks = stressTasks(runKey);
    expect(tasks.map((task) => task.key)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, "0")));
    expect(tasks.filter((task) => task.predecessors.length === 0).map((task) => task.key))
      .toEqual(["01", "02", "03", "04", "05", "06"]);
    expect(tasks.find((task) => task.key === "13")?.predecessors).toEqual(["11", "12"]);
    expect(tasks.find((task) => task.key === "14")?.predecessors).toEqual(["03", "04"]);
    expect(tasks.find((task) => task.key === "20")?.predecessors).toEqual(["19"]);
    expect(tasks[2]?.implementationFile).toBe(tasks[3]?.implementationFile);
    expect(new Set(tasks.map((task) => task.testFile)).size).toBe(20);
    expect(validateStressTasks(tasks)).toEqual({ ok: true });
  });

  it("rejects incomplete and out-of-order graphs, unexpected file conflicts and unsafe keys", () => {
    const tasks = stressTasks(runKey);
    expect(validateStressTasks(tasks.slice(1)).ok).toBe(false);
    expect(validateStressTasks([tasks[6]!, ...tasks.slice(0, 6), ...tasks.slice(7)]).ok).toBe(false);
    expect(validateStressTasks(tasks.map((task) => task.key === "05"
      ? { ...task, implementationFile: tasks[0]!.implementationFile } : task)).ok).toBe(false);
    expect(() => stressTasks("../unsafe")).toThrow(/run key/i);
  });

  it("builds backlog-only native dependency requests with first-block metadata and exact test scope", () => {
    const tasks = stressTasks(runKey);
    const root = buildStressIssue(tasks[0]!, "project-id", []);
    const join = buildStressIssue(tasks[13]!, "project-id", ["third-id", "fourth-id"]);
    expect(root).toMatchObject({ status: "backlog", projectId: "project-id", blockedByIssueIds: [],
      assigneeAdapterOverrides: { adapterConfig: { ciPolicy: "skip" } } });
    expect(join).toMatchObject({ blockedByIssueIds: ["third-id", "fourth-id"] });
    expect(root.description).toMatch(/^---\norchestrator_managed: true\n/);
    expect(root.description).toContain(`<!-- paperclip-adapters:stress-run:${runKey} -->`);
    expect(root.description).toContain(`node --test ${tasks[0]!.testFile}`);
    expect(root.description).toContain(tasks[0]!.implementationFile);
  });
});
