/**
 * Lightweight Daily Budget & Cost Optimization Tracker.
 * Tracks estimated and actual API token spend across Jules cloud sessions and strong model reviews (Grok/Terra/Gemini).
 * Enforces configurable daily spending limits and exports real-time cost telemetry.
 */

export interface CostRecord {
  readonly taskId: string;
  readonly taskIdentifier: string;
  readonly provider: "jules" | "grok" | "openai" | "gemini" | "anthropic" | "vibe" | "antigravity";
  readonly estimatedCostUsd: number;
  readonly timestamp: string;
  readonly operation: "implementation" | "review" | "clarification";
}

export interface DailyBudgetState {
  readonly date: string; // YYYY-MM-DD
  readonly dailyBudgetLimitUsd: number;
  readonly totalSpentTodayUsd: number;
  readonly records: readonly CostRecord[];
  readonly isBudgetExceeded: boolean;
}

// Unit cost estimates per operation
export const PROVIDER_UNIT_COSTS: Record<string, number> = Object.freeze({
  "jules-implementation": 0.05, // Avg Jules cloud session
  "grok-review": 0.01,         // Token-efficient Grok review
  "openai-review": 0.015,      // GPT-4o compact PR review
  "gemini-review": 0.005,      // Gemini 1.5 Pro compact PR review
  "anthropic-review": 0.015,   // Claude 3.5 Sonnet compact review
  "vibe-local": 0.00,          // Local developer lane
  "antigravity-local": 0.00,   // Local developer lane
});

export function getTodayDateString(): string {
  return new Date().toISOString().split("T")[0]!;
}

export function initializeDailyBudget(dailyLimitUsd: number = 10.0): DailyBudgetState {
  return Object.freeze({
    date: getTodayDateString(),
    dailyBudgetLimitUsd: dailyLimitUsd,
    totalSpentTodayUsd: 0.0,
    records: Object.freeze([]),
    isBudgetExceeded: false,
  });
}

export function recordOperationCost(
  currentState: DailyBudgetState,
  record: Omit<CostRecord, "timestamp">,
  nowIso: string = new Date().toISOString()
): DailyBudgetState {
  const today = getTodayDateString();
  
  // Rollover if new calendar day
  const baseState = currentState.date === today ? currentState : initializeDailyBudget(currentState.dailyBudgetLimitUsd);

  const fullRecord: CostRecord = {
    ...record,
    timestamp: nowIso,
  };

  const updatedRecords = [...baseState.records, fullRecord];
  const newTotal = Number((baseState.totalSpentTodayUsd + record.estimatedCostUsd).toFixed(4));
  const isExceeded = newTotal >= baseState.dailyBudgetLimitUsd;

  return Object.freeze({
    date: today,
    dailyBudgetLimitUsd: baseState.dailyBudgetLimitUsd,
    totalSpentTodayUsd: newTotal,
    records: Object.freeze(updatedRecords),
    isBudgetExceeded: isExceeded,
  });
}

export function formatBudgetTelemetrySummary(budget: DailyBudgetState): string {
  const pct = budget.dailyBudgetLimitUsd > 0 ? ((budget.totalSpentTodayUsd / budget.dailyBudgetLimitUsd) * 100).toFixed(1) : "0";
  const icon = budget.isBudgetExceeded ? "🚨" : Number(pct) > 80 ? "⚠️" : "💰";

  return `${icon} **Daily Budget:** $${budget.totalSpentTodayUsd.toFixed(2)} / $${budget.dailyBudgetLimitUsd.toFixed(2)} (${pct}% used)`;
}
