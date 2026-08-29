import { ConflictMatrixResult, JulesQuotaStatus, GitHubSyncStatus } from "./types.js";

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
}

export function formatOrchestratorDashboardCard(params: OrchestratorDashboardParams): string {
  const julesQuotaStr = params.julesQuota.fetchedLive
    ? `\`${params.julesQuota.activeSessionsCount}/${params.julesQuota.maxConcurrent}\` concurrent | \`${params.julesQuota.sessionsLast24hCount}/${params.julesQuota.maxDaily}\` daily`
    : `\`${params.julesRunning}/${params.julesCapacity}\` configured`;

  const lockRows = Array.from(params.ghStatus.openPrFiles)
    .slice(0, 10)
    .map((file) => `| \`${file}\` | Active PR lock |`)
    .join("\n");

  const locksTable =
    params.ghStatus.openPrFiles.size > 0
      ? `\n\n#### 🔒 Active File Locks (${params.ghStatus.openPrFiles.size} locked files)\n| File / Symbol | Lock Source |\n|---|---|\n${lockRows}${params.ghStatus.openPrFiles.size > 10 ? "\n| ... | ... |" : ""}`
      : "";

  return `### 🎛️ Orchestrator Live Telemetry & Scheduling Matrix

| Metric | Status |
|---|---|
| **Backlog Overview** | 📊 Total: **${params.totalIssues}** (Todo: ${params.todoCount}, Running: ${params.inProgressCount}, Review: ${params.inReviewCount}, Resolved: ${params.resolvedCount}) |
| **Jules Cloud Lane** | ⚡ ${julesQuotaStr} (Running: **${params.julesRunning}**) |
| **Vibe Local Lane** | 💻 \`${params.vibeRunning}/${params.vibeCapacity}\` active slots |
| **Conflict Matrix** | 🔗 **${params.conflictResult.conflictEdges.length}** DAG conflict edges evaluated |
| **Operator Approvals** | ⏳ **${params.approvalsPendingCount}** pending start approvals |
| **Execution Latency** | ⏱️ ${params.elapsedMs}ms |${locksTable}`;
}
