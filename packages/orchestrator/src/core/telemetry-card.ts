import { AgentHealthReport, formatAgentHealthAlertDigest } from "./agent-health-monitor.js";
import { ConflictMatrixResult, JulesQuotaStatus, GitHubSyncStatus } from "./types.js";
import { DailyBudgetState, formatBudgetTelemetrySummary } from "./cost-tracker.js";

export interface OrchestratorDashboardParams {
  companyId: string;
  totalIssues: number;
  inProgressCount: number;
  inReviewCount: number;
  resolvedCount: number;
  todoCount: number;
  julesQuota: JulesQuotaStatus;
  julesRunning: number;
  julesCapacity: number;
  vibeRunning: number;
  vibeCapacity: number;
  ghStatus: GitHubSyncStatus;
  conflictResult: ConflictMatrixResult;
  approvalsPendingCount: number;
  elapsedMs: number;
  rateLimitPausedUntilMs?: number | undefined;
  nowMs?: number | undefined;
  dailyBudget?: DailyBudgetState | undefined;
  agentHealth?: AgentHealthReport | undefined;
}

export function formatOrchestratorDashboardCard(params: OrchestratorDashboardParams): string {
  const now = params.nowMs ?? Date.now();
  let julesStatusStr = "";

  if (params.rateLimitPausedUntilMs && params.rateLimitPausedUntilMs > now) {
    const remainingSec = Math.ceil((params.rateLimitPausedUntilMs - now) / 1000);
    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    julesStatusStr = `⏸️ **Paused** (Rate limit cooldown: \`${timeStr}\` remaining)`;
  } else if (params.julesQuota.fetchedLive) {
    const capacityRemaining = params.julesQuota.effectiveAvailableCapacity;
    const isExhausted = capacityRemaining <= 0;
    const badge = isExhausted ? "⏸️ **Full/Exhausted**" : "⚡ **Active**";
    julesStatusStr = `${badge} (\`${params.julesQuota.activeSessionsCount}/${params.julesQuota.maxConcurrent}\` concurrent, \`${params.julesQuota.sessionsLast24hCount}/${params.julesQuota.maxDaily}\` daily rolling)`;
  } else if (params.julesQuota.error) {
    julesStatusStr = `**Quota unavailable** — ${params.julesQuota.error} (dispatch capacity 0)`;
  } else {
    julesStatusStr = `\`${params.julesRunning}/${params.julesCapacity}\` configured`;
  }

  const budgetRow = params.dailyBudget
    ? `\n| **Daily Cloud Spend** | ${formatBudgetTelemetrySummary(params.dailyBudget)} |`
    : "";

  const lockRows = Array.from(params.ghStatus.openPrFiles)
    .slice(0, 10)
    .map((file) => `| \`${file}\` | Active PR lock |`)
    .join("\n");

  const locksTable =
    params.ghStatus.openPrFiles.size > 0
      ? `\n\n#### 🔒 Active File Locks (${params.ghStatus.openPrFiles.size} locked files)\n| File / Symbol | Lock Source |\n|---|---|\n${lockRows}${params.ghStatus.openPrFiles.size > 10 ? "\n| ... | ... |" : ""}`
      : "";

  const incidentsSection = params.agentHealth && !params.agentHealth.isHealthy
    ? `

${formatAgentHealthAlertDigest(params.agentHealth)}`
    : "";

  return `### 🎛️ Orchestrator Live Telemetry & Scheduling Matrix

| Metric | Status |
|---|---|
| **Backlog Overview** | 📊 Total: **${params.totalIssues}** (Todo: ${params.todoCount}, Running: ${params.inProgressCount}, Review: ${params.inReviewCount}, Resolved: ${params.resolvedCount}) |
| **Jules Cloud Lane** | ${julesStatusStr} |
| **Vibe Local Lane** | 💻 \`${params.vibeRunning}/${params.vibeCapacity}\` active slots |
| **Conflict Matrix** | 🔗 **${params.conflictResult.conflictEdges.length}** DAG conflict edges evaluated |
| **Operator Approvals** | ⏳ **${params.approvalsPendingCount}** pending start approvals |
| **Execution Latency** | ⏱️ ${params.elapsedMs}ms |${budgetRow}${locksTable}${incidentsSection}`;
}
