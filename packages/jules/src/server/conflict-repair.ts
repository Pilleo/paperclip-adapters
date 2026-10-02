import { parseConflictRepairTask } from "@pilleo/paperclip-adapter-common";

export function conflictRepairStartingBranch(description: string, agentId: string, companyId: string,
  repository: string, defaultBranch: string): string {
  const task = parseConflictRepairTask(description);
  if (!task) return defaultBranch;
  const repo = new URL(task.prUrl).pathname.split("/").slice(1, 3).join("/");
  if (task.agentId !== agentId || task.companyId !== companyId || repo.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("Remote conflict repair assignment does not match its agent, company or repository");
  }
  return task.headRef;
}
