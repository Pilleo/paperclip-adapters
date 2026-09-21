import { describe, expect, it } from "vitest";
import {
  E2E_PROJECT_MARKER,
  assertProjectReadyForCanary,
  canaryProjectIssuesPath,
  ensureSingleDisposableProject,
  selectExistingDisposableProject,
} from "../src/core/real-e2e-project-registry.js";

describe("reusable real E2E project registry", () => {
  it("loads every issue from the configured project before deciding that a new canary is safe", () => {
    expect(canaryProjectIssuesPath("company/a", "project b")).toBe(
      "/api/companies/company%2Fa/issues?projectId=project+b&limit=200",
    );
  });

  it("uses only the explicitly configured existing disposable project", () => {
    expect(selectExistingDisposableProject([
      { id: "project-1", description: E2E_PROJECT_MARKER },
      { id: "project-2", description: "unrelated" },
    ], "project-2")).toEqual({ kind: "reuse", project: { id: "project-2", description: "unrelated" } });
  });

  it("fails closed when the configured disposable project is absent", () => {
    expect(selectExistingDisposableProject([{ id: "project-1" }], "missing"))
      .toEqual({ kind: "invalid_missing", projectId: "missing" });
  });

  it("requests creation when no marked project exists", () => {
    expect(ensureSingleDisposableProject([])).toEqual({ kind: "create" });
  });

  it("reuses the single v2-marked project", () => {
    expect(ensureSingleDisposableProject([{ id: "project-1", description: E2E_PROJECT_MARKER }]))
      .toEqual({ kind: "reuse", project: { id: "project-1", description: E2E_PROJECT_MARKER } });
  });

  it("fails closed when duplicate marked projects exist", () => {
    expect(ensureSingleDisposableProject([
      { id: "project-1", description: E2E_PROJECT_MARKER },
      { id: "project-2", description: `old\n${E2E_PROJECT_MARKER}` },
    ])).toEqual({ kind: "invalid_duplicate", projectIds: ["project-1", "project-2"] });
  });

  it("refuses a new run while a marked canary task is nonterminal", () => {
    expect(assertProjectReadyForCanary([
      { id: "a", status: "done", description: "<!-- paperclip-adapters:e2e-run:old -->" },
      { id: "b", status: "in_progress", description: "<!-- paperclip-adapters:e2e-run:old -->" },
    ])).toEqual({ ok: false, blockingIssueIds: ["b"] });
  });
});
