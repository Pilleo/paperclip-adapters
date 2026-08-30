import { describe, expect, it } from "vitest";
import { evaluateJulesStartGate } from "../src/server/start-gate.js";

const pending = {
  id: "app-1",
  type: "request_board_approval",
  status: "pending",
  issueIds: ["issue-822"],
  payload: { action: "task_start", issueId: "issue-822" },
};

describe("Jules task_start gate", () => {
  it.each([
    {
      desc: "pending start card blocks a wakeup",
      approvals: [pending],
      issueId: "issue-822",
      allow: false,
    },
    {
      desc: "approved start card allows work",
      approvals: [{ ...pending, status: "approved" }],
      issueId: "issue-822",
      allow: true,
    },
    {
      desc: "rejected start card blocks work",
      approvals: [{ ...pending, status: "rejected" }],
      issueId: "issue-822",
      allow: false,
    },
    {
      desc: "unrelated issue is not blocked by this card",
      approvals: [pending],
      issueId: "issue-other",
      allow: true,
    },
  ])("$desc", ({ approvals, issueId, allow }) => {
    expect(evaluateJulesStartGate(approvals, issueId).allow).toBe(allow);
  });
});
