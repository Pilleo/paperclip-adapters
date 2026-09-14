import { describe, expect, it } from "vitest";
import { allocateCompanyJulesAdmissions } from "../src/core/jules-admission.js";

describe("allocateCompanyJulesAdmissions", () => {
  it("admits no more than the company-wide new-session budget", () => {
    const allocations = allocateCompanyJulesAdmissions({
      projectIds: ["alpha", "beta", "gamma", "delta"],
      maxNewSessions: 3,
      rotationOffset: 0,
    });

    expect(allocations).toEqual([
      { projectId: "alpha", newSessionBudget: 1 },
      { projectId: "beta", newSessionBudget: 1 },
      { projectId: "gamma", newSessionBudget: 1 },
      { projectId: "delta", newSessionBudget: 0 },
    ]);
    expect(allocations.reduce((total, allocation) => total + allocation.newSessionBudget, 0)).toBe(3);
  });

  it("rotates priority between projects without changing the total budget", () => {
    const allocations = allocateCompanyJulesAdmissions({
      projectIds: ["alpha", "beta", "gamma", "delta"],
      maxNewSessions: 3,
      rotationOffset: 2,
    });

    expect(allocations).toEqual([
      { projectId: "alpha", newSessionBudget: 1 },
      { projectId: "beta", newSessionBudget: 0 },
      { projectId: "gamma", newSessionBudget: 1 },
      { projectId: "delta", newSessionBudget: 1 },
    ]);
  });

  it("does not accept active-session counts as an admission input", () => {
    expect(allocateCompanyJulesAdmissions({
      projectIds: ["alpha", "beta"],
      maxNewSessions: 3,
      rotationOffset: 0,
    })).toEqual([
      { projectId: "alpha", newSessionBudget: 2 },
      { projectId: "beta", newSessionBudget: 1 },
    ]);
  });
});
