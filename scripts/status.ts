#!/usr/bin/env tsx

interface Company {
  id: string;
  name: string;
  issuePrefix?: string;
}

interface Issue {
  id: string;
  identifier?: string;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  updatedAt?: string;
}

interface Agent {
  id: string;
  name: string;
  adapterType: string;
  status?: string;
  adapterConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const API_URL = process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100";

async function main() {
  console.log("\n" + "=".repeat(80));
  console.log("  🎛️  PAPERCLIP ADAPTERS & ORCHESTRATION FLEET DASHBOARD");
  console.log("=".repeat(80) + "\n");

  try {
    const companiesRes = await fetch(`${API_URL}/api/companies`);
    if (!companiesRes.ok) {
      throw new Error(`Paperclip server unreachable at ${API_URL}`);
    }
    const companies = (await companiesRes.json()) as Company[];

    if (companies.length === 0) {
      console.log("No companies found in Paperclip.");
      return;
    }

    for (const company of companies) {
      console.log(`🏢 Company: \x1b[1m\x1b[36m${company.name}\x1b[0m (${company.id})`);
      console.log("-".repeat(80));

      // 1. Fetch Issues
      const issuesRes = await fetch(`${API_URL}/api/companies/${company.id}/issues`);
      const issues: Issue[] = issuesRes.ok ? await issuesRes.json() : [];

      const statusCounts: Record<string, number> = {
        backlog: 0,
        todo: 0,
        in_progress: 0,
        in_review: 0,
        done: 0,
        blocked: 0,
        cancelled: 0,
      };

      for (const issue of issues) {
        statusCounts[issue.status] = (statusCounts[issue.status] || 0) + 1;
      }

      console.log("\n📊 \x1b[1mKanban Board Status:\x1b[0m");
      console.log(
        `  📥 Backlog: \x1b[33m${statusCounts.backlog}\x1b[0m | ` +
        `⏳ Todo: \x1b[34m${statusCounts.todo}\x1b[0m | ` +
        `⚡ In Progress: \x1b[35m${statusCounts.in_progress}\x1b[0m | ` +
        `🔍 In Review: \x1b[36m${statusCounts.in_review}\x1b[0m | ` +
        `✅ Done: \x1b[32m${statusCounts.done}\x1b[0m | ` +
        `🚫 Blocked: \x1b[31m${statusCounts.blocked}\x1b[0m`
      );

      // 2. In-Flight Issues
      const inFlight = issues.filter(
        (i) => i.status === "in_progress" || i.status === "in_review"
      );

      if (inFlight.length > 0) {
        console.log("\n🚀 \x1b[1mActive In-Flight Work:\x1b[0m");
        for (const task of inFlight) {
          const statusIcon = task.status === "in_progress" ? "⚡" : "🔍";
          const assignee = task.assigneeAgentId || task.assigneeUserId || "unassigned";
          console.log(`  ${statusIcon} [${task.identifier || task.id}] ${task.title} (\x1b[2m${task.status}\x1b[0m, assignee: \x1b[33m${assignee}\x1b[0m)`);
        }
      } else {
        console.log("\n🚀 \x1b[1mActive In-Flight Work:\x1b[0m None (Board is clean, awaiting approvals)");
      }

      // 3. Fetch Agents / Fleet
      const agentsRes = await fetch(`${API_URL}/api/companies/${company.id}/agents`);
      const agents: Agent[] = agentsRes.ok ? await agentsRes.json() : [];

      console.log("\n🤖 \x1b[1mRegistered Agents & Managed Fleet:\x1b[0m");
      for (const agent of agents) {
        const isManaged = agent.name.startsWith("[Orchestrated]") || agent.metadata?.["managedBy"] === "paperclip-orchestrator";
        const pollCadence = agent.adapterConfig?.["pollCadenceSeconds"] ?? "default";
        const badge = isManaged ? "\x1b[32m[Orchestrated Locked]\x1b[0m" : "\x1b[2m[Standard]\x1b[0m";
        const statusColor = agent.status === "running" ? "\x1b[32m" : "\x1b[33m";
        console.log(`  • ${agent.name} (${agent.adapterType}) -> ${statusColor}${agent.status || "unknown"}\x1b[0m ${badge} \x1b[2m(pollCadence: ${pollCadence})\x1b[0m`);
      }

      console.log("\n" + "=".repeat(80) + "\n");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31mError querying dashboard:\x1b[0m ${msg}`);
  }
}

main();
