export interface AgentHealthInput {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly errorReason?: string | null | undefined;
  readonly pauseReason?: string | null | undefined;
  readonly orgChainHealth?: {
    readonly status?: string | undefined;
    readonly reason?: string | undefined;
    readonly escalationWarning?: string | undefined;
  } | undefined;
}

export type IncidentSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface AgentIncident {
  readonly agentId: string;
  readonly agentName: string;
  readonly severity: IncidentSeverity;
  readonly status: string;
  readonly issue: string;
  readonly remediation: string;
}

export interface AgentHealthReport {
  readonly isHealthy: boolean;
  readonly totalAgentsCount: number;
  readonly errorAgentsCount: number;
  readonly pausedAgentsCount: number;
  readonly incidents: readonly AgentIncident[];
}

/**
 * Pure evaluator that inspects company agents for formal failures, fatal error states,
 * unhandled crash pauses, and broken escalation chains.
 */
export function evaluateAgentHealth(agents: readonly AgentHealthInput[]): AgentHealthReport {
  const incidents: AgentIncident[] = [];
  let errorCount = 0;
  let pausedCount = 0;

  for (const agent of agents) {
    // 1. Critical: Agent is in explicit error status or has errorReason
    if (agent.status === "error" || (agent.errorReason && agent.errorReason.trim().length > 0)) {
      errorCount++;
      const reason = agent.errorReason || `Agent status is "${agent.status}" without detailed reason.`;
      incidents.push({
        agentId: agent.id,
        agentName: agent.name,
        severity: "CRITICAL",
        status: agent.status,
        issue: reason,
        remediation: "Inspect adapter logs, verify credentials/secrets, and restart the agent run.",
      });
      continue;
    }

    // 2. High: Agent is paused due to an error or crash
    if (agent.status === "paused") {
      pausedCount++;
      if (agent.pauseReason && agent.pauseReason.trim().length > 0) {
        const isErrorCrash =
          agent.pauseReason.toLowerCase().includes("crash") ||
          agent.pauseReason.toLowerCase().includes("error") ||
          agent.pauseReason.toLowerCase().includes("exception") ||
          agent.pauseReason.toLowerCase().includes("429") ||
          agent.pauseReason.toLowerCase().includes("401") ||
          agent.pauseReason.toLowerCase().includes("sigsegv") ||
          agent.pauseReason.toLowerCase().includes("sigterm");

        if (isErrorCrash) {
          incidents.push({
            agentId: agent.id,
            agentName: agent.name,
            severity: "HIGH",
            status: agent.status,
            issue: agent.pauseReason,
            remediation: "Unpause the agent after resolving the underlying environment or quota issue.",
          });
        }
      }
    }

    // 3. Medium: Broken chain of command / unreachable escalation path
    if (agent.orgChainHealth && agent.orgChainHealth.status !== "healthy") {
      const warning =
        agent.orgChainHealth.reason ||
        agent.orgChainHealth.escalationWarning ||
        "Chain of command reports broken status.";
      incidents.push({
        agentId: agent.id,
        agentName: agent.name,
        severity: "MEDIUM",
        status: agent.status,
        issue: warning,
        remediation: "Reassign reportsTo or unpause the supervising manager agent.",
      });
    }
  }

  return {
    isHealthy: incidents.length === 0,
    totalAgentsCount: agents.length,
    errorAgentsCount: errorCount,
    pausedAgentsCount: pausedCount,
    incidents: Object.freeze(incidents),
  };
}

/**
 * Formats a clean markdown alert digest summarizing formal agent failures.
 */
export function formatAgentHealthAlertDigest(report: AgentHealthReport): string {
  if (report.isHealthy) {
    return "✅ **Fleet Health:** All managed agents are healthy and operating normally.";
  }

  const lines: string[] = [
    `### 🚨 **Agent Health Incident Alert** (${report.incidents.length} active issue${report.incidents.length > 1 ? "s" : ""})`,
    "",
  ];

  for (const inc of report.incidents) {
    lines.push(`- **[${inc.severity}] ${inc.agentName}** (\`${inc.status}\`)`);
    lines.push(`  - **Issue:** ${inc.issue}`);
    lines.push(`  - **Remediation:** ${inc.remediation}`);
  }

  return lines.join("\n");
}
