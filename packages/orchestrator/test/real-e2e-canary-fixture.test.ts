import { describe, expect, it } from "vitest";
import {
  assertAuthoritativeCanaryChain,
  buildCanaryOrchestratorWake,
  buildCanaryA,
  buildCanaryB,
  buildCanaryC,
  buildDisposableCanaryBootstrapIssue,
} from "../src/core/real-e2e-canary-fixture.js";
import { extractIssueMetadata } from "../src/core/parser.js";
import { parseTaskContract } from "@pilleo/paperclip-adapter-common";

describe("real provider E2E canary fixture", () => {
  it("creates a completed non-blocking bootstrap anchor", () => {
    expect(buildDisposableCanaryBootstrapIssue("project-1")).toMatchObject({
      projectId: "project-1",
      status: "done",
      assigneeAgentId: null,
      executionPolicy: null,
      executionState: null,
    });
  });

  it("builds a native A -> B -> C chain with disjoint scopes", () => {
    expect(buildCanaryA("project-1", "run-1")).toMatchObject({
      projectId: "project-1",
      status: "todo",
      assigneeAdapterOverrides: { adapterConfig: { ciPolicy: "skip" } },
      description: expect.stringContaining("<!-- paperclip-adapters:e2e-run:run-1 -->"),
    });
    expect(buildCanaryB("project-1", "run-1", "a")).toMatchObject({
      blockedByIssueIds: ["a"],
      assigneeAdapterOverrides: { adapterConfig: { ciPolicy: "skip" } },
      description: expect.stringContaining("decrement.js"),
    });
    expect(buildCanaryC("project-1", "run-1", "b")).toMatchObject({
      blockedByIssueIds: ["b"],
      assigneeAdapterOverrides: { adapterConfig: { ciPolicy: "skip" } },
      description: expect.stringContaining("is-zero.js"),
    });
  });

  it("states exact behavior, test-file scope and runnable verification for a reviewer-approved increment plan", () => {
    const description = String(buildCanaryA("project-1", "run-1").description);
    expect(parseTaskContract(description)).toMatchObject({ kind: "structured", targetFiles: [
      "canary-run-1-increment.js", "canary-run-1-increment.test.js",
    ] });
    expect(description).toContain("increment(2) returns 3");
    expect(description).toContain("node --test canary-run-1-increment.test.js");
  });

  it.each([
    ["A", () => buildCanaryA("project-1", "run-1")],
    ["B", () => buildCanaryB("project-1", "run-1", "a")],
    ["C", () => buildCanaryC("project-1", "run-1", "b")],
  ])("renders %s as one canonical managed task contract", (_name, build) => {
    const issue = build();
    const description = String(issue.description);
    const parsed = parseTaskContract(description);
    const metadata = extractIssueMetadata({
      id: "canary",
      title: String(issue.title),
      status: String(issue.status),
      description,
    });

    expect(description).toMatch(/^---\n[\s\S]*?---\n<!-- paperclip-adapters:e2e-run:run-1 -->/);
    expect(metadata.orchestratorManaged).toBe(true);
    expect(parsed).toMatchObject({ kind: "structured", targetFiles: [
      expect.stringMatching(/^canary-run-1-.+\.js$/), expect.stringMatching(/^canary-run-1-.+\.test\.js$/),
    ] });
  });

  it("gives each canary run fresh implementation filenames so a merged run cannot make the next run a no-op", () => {
    const first = buildCanaryA("project-1", "run-1");
    const second = buildCanaryA("project-1", "run-2");

    expect(first.description).toContain("canary-run-1-increment.js");
    expect(second.description).toContain("canary-run-2-increment.js");
    expect(first.description).not.toContain("canary-run-2-increment.js");
  });

  it("makes each generated card identity run-unique so Paperclip cannot deduplicate a child into an older canary", () => {
    const first = buildCanaryB("project-1", "run-1", "a-1");
    const second = buildCanaryB("project-1", "run-2", "a-2");

    expect(first.title).not.toEqual(second.title);
    expect(first.title).toContain("[e2e:run-1]");
    expect(second.title).toContain("[e2e:run-2]");
  });

  it("accepts only authoritative blockedBy edges", () => {
    expect(assertAuthoritativeCanaryChain(
      { id: "a", blockedBy: [] },
      { id: "b", blockedBy: [{ id: "a" }] },
      { id: "c", blockedBy: [{ id: "b" }] },
    )).toEqual({ ok: true });
    expect(assertAuthoritativeCanaryChain(
      { id: "a", blockedBy: [] },
      { id: "b", blockedByIssueIds: ["a"] },
      { id: "c", blockedBy: [{ id: "b" }] },
    )).toEqual({ ok: false, reason: "b_missing_authoritative_blocker" });
  });

  it("builds one explicit project-scoped orchestrator wake", () => {
    expect(buildCanaryOrchestratorWake("project-1", "run-1")).toEqual({
      source: "on_demand",
      reason: "paperclip-orchestrator-scope/v1/project/project-1",
      idempotencyKey: "real-project-canary:project-1:run-1",
      payload: { projectId: "project-1" },
    });
  });
});
