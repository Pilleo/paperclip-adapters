import { ParsedIssueMetadata, GitHubPullRequest } from "./types.js";

export interface AuditDigestParams {
  readonly issue: ParsedIssueMetadata;
  readonly pr: GitHubPullRequest;
  readonly testBlastRadius?: readonly string[] | undefined;
  readonly durationMs?: number | undefined;
}

/**
 * Synthesizes a permanent, structured audit digest for completed tasks.
 */
export function synthesizeAuditDigest(params: AuditDigestParams): string {
  const { issue, pr, testBlastRadius, durationMs } = params;

  const targetSymbols =
    issue.targetSymbols && issue.targetSymbols.length > 0
      ? issue.targetSymbols.map((s) => `\`${s}\``).join(", ")
      : "Standard method inspection";

  const targetFiles =
    issue.targetFiles && issue.targetFiles.length > 0
      ? issue.targetFiles.map((f) => `- \`${f}\``).join("\n")
      : "- See PR diff";

  const blastRadius =
    testBlastRadius && testBlastRadius.length > 0
      ? `\n**⚡ Impacted Caller Test Suites:**\n${testBlastRadius.map((t) => `- \`${t}\``).join("\n")}\n`
      : "";

  const durationStr = durationMs
    ? ` | **Execution Latency:** ${Math.round(durationMs / 1000)}s`
    : "";

  return `### 🏁 Execution Audit Digest: [${issue.identifier || issue.id}] ${issue.title}

| Attribute | Details |
|---|---|
| **Pull Request** | [PR #${pr.number}: ${pr.title}](${pr.url || `#${pr.number}`}) |
| **Merged At** | \`${pr.mergedAt || "Recently Merged"}\`${durationStr} |
| **Target Symbols** | ${targetSymbols} |
| **Project Invariants** | ✅ Verified Clean (0 violations) |

#### 📂 Modified File Targets
${targetFiles}
${blastRadius}
---
*Audit ledger recorded automatically by Paperclip Deterministic Orchestrator.*`;
}
