import { describe, it, expect } from "vitest";
import {
  initializeDailyBudget,
  recordOperationCost,
  formatBudgetTelemetrySummary,
  getTodayDateString,
} from "../src/core/cost-tracker.js";

describe("Daily Budget & Cost Tracker", () => {
  it("initializes daily budget with zero spend", () => {
    const budget = initializeDailyBudget(5.0);
    expect(budget.dailyBudgetLimitUsd).toBe(5.0);
    expect(budget.totalSpentTodayUsd).toBe(0.0);
    expect(budget.isBudgetExceeded).toBe(false);
    expect(budget.records.length).toBe(0);
  });

  it("records operation costs and increments total spend", () => {
    let budget = initializeDailyBudget(1.0);
    budget = recordOperationCost(budget, {
      taskId: "task-1",
      taskIdentifier: "MAZ-100",
      provider: "jules",
      estimatedCostUsd: 0.05,
      operation: "implementation",
    });

    budget = recordOperationCost(budget, {
      taskId: "task-1",
      taskIdentifier: "MAZ-100",
      provider: "grok",
      estimatedCostUsd: 0.01,
      operation: "review",
    });

    expect(budget.totalSpentTodayUsd).toBe(0.06);
    expect(budget.records.length).toBe(2);
    expect(budget.isBudgetExceeded).toBe(false);
  });

  it("flags when daily budget limit is reached or exceeded", () => {
    let budget = initializeDailyBudget(0.1);
    budget = recordOperationCost(budget, {
      taskId: "task-1",
      taskIdentifier: "MAZ-100",
      provider: "jules",
      estimatedCostUsd: 0.05,
      operation: "implementation",
    });
    budget = recordOperationCost(budget, {
      taskId: "task-2",
      taskIdentifier: "MAZ-101",
      provider: "jules",
      estimatedCostUsd: 0.06,
      operation: "implementation",
    });

    expect(budget.totalSpentTodayUsd).toBe(0.11);
    expect(budget.isBudgetExceeded).toBe(true);

    const summary = formatBudgetTelemetrySummary(budget);
    expect(summary).toContain("🚨");
    expect(summary).toContain("$0.11 / $0.10");
  });

  it("rolls over automatically if date advances", () => {
    const yesterdayState = {
      date: "2026-08-01",
      dailyBudgetLimitUsd: 5.0,
      totalSpentTodayUsd: 4.5,
      records: [],
      isBudgetExceeded: false,
    };

    const updated = recordOperationCost(yesterdayState, {
      taskId: "task-new",
      taskIdentifier: "MAZ-200",
      provider: "jules",
      estimatedCostUsd: 0.05,
      operation: "implementation",
    });

    expect(updated.date).toBe(getTodayDateString());
    expect(updated.totalSpentTodayUsd).toBe(0.05); // Rolled over from yesterday
  });
});
