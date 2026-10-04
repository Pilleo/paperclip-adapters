import { describe, expect, it } from "vitest";
import { classifyJulesStatusOnlyRun } from "../src/server/status-only-run.js";

const original = { id: "run-1", companyId: "company-1", agentId: "jules-1", status: "running",
  contextSnapshot: { issueId: "issue-1", wakeReason: "missing_issue_comment" } };
const expected = { runId: "run-1", companyId: "company-1", agentId: "jules-1", issueId: "issue-1" };

describe("Jules status-only host continuation", () => {
  it("permits only a status note for an exact running missing-comment run", () => {
    expect(classifyJulesStatusOnlyRun({ run: original, expected })).toEqual({
      kind: "status_comment", issueId: "issue-1",
    });
  });

  it("never treats another issue, agent, or terminal run as a permissible status-only mutation", () => {
    expect(classifyJulesStatusOnlyRun({ run: original,
      expected: { ...expected, issueId: "another" } }).kind).toBe("invalid");
    expect(classifyJulesStatusOnlyRun({ run: { ...original, agentId: "other" }, expected }).kind).toBe("invalid");
    expect(classifyJulesStatusOnlyRun({ run: { ...original, status: "failed" }, expected }).kind).toBe("invalid");
  });

  it("refuses to reclassify a normal provider or reviewer wake as status-only", () => {
    expect(classifyJulesStatusOnlyRun({ run: { ...original,
      contextSnapshot: { ...original.contextSnapshot, wakeReason: "issue_assigned" } }, expected }))
      .toEqual({ kind: "normal" });
    expect(classifyJulesStatusOnlyRun({ run: { ...original,
      contextSnapshot: { ...original.contextSnapshot, issueId: "" } }, expected }).kind).toBe("invalid");
  });

  it("retains host status-only authority after a monitor wake coalesces into the run", () => {
    expect(classifyJulesStatusOnlyRun({ run: { ...original, contextSnapshot: {
      issueId: "issue-1", wakeReason: "issue_monitor_due", recoveryIntent: "status_only",
      allowDeliverableWork: false, allowDocumentUpdates: false, resumeRequiresNormalModel: true,
    } }, expected })).toEqual({ kind: "status_comment", issueId: "issue-1" });
  });

  it.each(["allowDeliverableWork", "allowDocumentUpdates", "resumeRequiresNormalModel"])(
    "fails closed when status-only context loses %s", (field) => {
      const contextSnapshot: Record<string, unknown> = {
        issueId: "issue-1", wakeReason: "issue_monitor_due", recoveryIntent: "status_only",
        allowDeliverableWork: false, allowDocumentUpdates: false, resumeRequiresNormalModel: true,
      };
      delete contextSnapshot[field];
      expect(classifyJulesStatusOnlyRun({ run: { ...original, contextSnapshot }, expected }).kind)
        .toBe("invalid");
    });
});
