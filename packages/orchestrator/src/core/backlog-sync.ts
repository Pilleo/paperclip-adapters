import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cachedInferTargetFiles, needsWorkPackageFill } from "./work-package-ingest.js";
import { resolvePaperclipProject, type PaperclipProjectRecord } from "./parser.js";
import { stripPaperclipIdentityMetadata } from "@pilleo/paperclip-adapter-common";

export interface BacklogSyncOptions {
  readonly workspacePath: string;
  readonly companyId: string;
  readonly apiUrl: string;
  readonly backlogDirectory?: string | undefined;
  readonly resolvedDirectory?: string | undefined;
  readonly projectId?: string | undefined;
  readonly gitRemoteUrl?: string | undefined;
  readonly projects?: readonly PaperclipProjectRecord[] | undefined;
  /** Agent that owns imported work until the orchestrator dispatches it. */
  readonly orchestratorAgentId?: string | undefined;
  /** Managed execution agents are allowed to hold imported work after dispatch. */
  readonly managedAgentIds?: ReadonlySet<string> | undefined;
}

export interface SyncIssueResult {
  readonly filePath: string;
  readonly issueId: string;
  readonly title: string;
  readonly action: "created" | "updated" | "unchanged";
  readonly paperclipId: string;
  readonly paperclipIdentifier?: string | undefined;
}

export interface BacklogIdentityConflict {
  readonly filePath: string;
  readonly logicalId: string;
  readonly candidateIssueIds: readonly string[];
  readonly reason: string;
}

export interface BacklogSyncSummary {
  readonly discoveredCount: number;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly syncedHeadersCount: number;
  readonly results: readonly SyncIssueResult[];
  readonly conflicts: readonly BacklogIdentityConflict[];
}

export type BacklogIssueCandidate = Record<string, any> & {
  id: string;
  status?: string | undefined;
  title?: string | undefined;
  assigneeAgentId?: string | null | undefined;
  identifier?: string | null | undefined;
  projectId?: string | null | undefined;
};

/**
 * Resolves a backlog file to a Paperclip issue without fuzzy description
 * matching. A declared Paperclip id wins; otherwise an exact canonical title
 * may resolve one legacy issue, while duplicates are explicitly ambiguous.
 */
export function resolveBacklogIssueCandidates(
  issues: readonly BacklogIssueCandidate[],
  declaredPaperclipId: string | undefined,
  formattedTitle: string,
): { readonly issue?: BacklogIssueCandidate; readonly candidates: readonly BacklogIssueCandidate[]; readonly declaredMismatch?: BacklogIssueCandidate } {
  const reusable = (issue: BacklogIssueCandidate) => issue.status !== "cancelled";
  const declared = declaredPaperclipId
    ? issues.find((issue) => reusable(issue) && issue.id === declaredPaperclipId)
    : undefined;
  // A copied/stale header must not attach a new backlog file to an unrelated
  // issue. Require the canonical title to agree before treating the declared
  // id as authoritative; callers quarantine mismatches for explicit repair.
  if (declared && declared.title === formattedTitle) return { issue: declared, candidates: Object.freeze([declared]) };
  if (declared) return { candidates: Object.freeze([]), declaredMismatch: declared };
  const candidates = issues.filter((issue) => reusable(issue) && issue.title === formattedTitle);
  return { candidates: Object.freeze(candidates) };
}

export function parseYamlFrontmatter(content: string): {
  readonly fields: Record<string, any>;
  readonly body: string;
  readonly frontmatterStr: string;
} | null {
  if (!content.startsWith("---")) return null;
  const secondTriple = content.indexOf("---", 3);
  if (secondTriple === -1) return null;

  const frontmatterStr = content.slice(3, secondTriple);
  const body = content.slice(secondTriple + 3).trim();
  const fields: Record<string, any> = {};

  const lines = frontmatterStr.split("\n");
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("- ") && currentKey) {
      if (!currentList) currentList = [];
      currentList.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ""));
      fields[currentKey] = currentList;
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) {
      currentKey = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();

      if (value.startsWith("[") && value.endsWith("]")) {
        fields[currentKey] = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        currentList = null;
      } else if (!value) {
        currentList = [];
        fields[currentKey] = currentList;
      } else {
        fields[currentKey] = value.replace(/^["']|["']$/g, "");
        currentList = null;
      }
    }
  }

  return { fields, body, frontmatterStr };
}

export function updateFileFrontmatter(
  filePath: string,
  content: string,
  keyValues: Record<string, string>
): void {
  const parsed = parseYamlFrontmatter(content);
  if (!parsed) return;

  const frontmatterLines = parsed.frontmatterStr.split("\n");
  const newLines: string[] = [];
  const handledKeys = new Set<string>();

  for (const line of frontmatterLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      const keyLower = key.toLowerCase();
      const val = keyValues[keyLower];
      if (val !== undefined) {
        newLines.push(`${key}: "${val}"`);
        handledKeys.add(keyLower);
        continue;
      }
    }
    newLines.push(line);
  }

  for (const [k, v] of Object.entries(keyValues)) {
    if (!handledKeys.has(k.toLowerCase()) && v) {
      newLines.push(`${k}: "${v}"`);
    }
  }

  const updatedContent = `---\n${newLines.join("\n").trim()}\n---\n\n${parsed.body}\n`;
  fs.writeFileSync(filePath, updatedContent, "utf-8");
}

export function readWorkspaceGitRemote(workspacePath: string): string | undefined {
  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return remote.length > 0 ? remote : undefined;
  } catch {
    return undefined;
  }
}

export function scanBacklogDirectory(backlogDir: string): string[] {
  if (!fs.existsSync(backlogDir)) return [];
  const results: string[] = [];

  function walk(current: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "resolved" && entry.name !== "archive" && entry.name !== ".git") {
          walk(full);
        }
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md") {
        results.push(full);
      }
    }
  }

  walk(backlogDir);
  return results;
}

export async function syncBacklogMarkdownToPaperclip(options: BacklogSyncOptions): Promise<BacklogSyncSummary> {
  const backlogDir = path.isAbsolute(options.backlogDirectory || "")
    ? (options.backlogDirectory as string)
    : path.join(options.workspacePath, options.backlogDirectory || "docs/internals/backlog");
  const files = scanBacklogDirectory(backlogDir);

  if (files.length === 0) {
    return Object.freeze({
      discoveredCount: 0,
      createdCount: 0,
      updatedCount: 0,
      syncedHeadersCount: 0,
      results: Object.freeze([]),
      conflicts: Object.freeze([]),
    });
  }

  let existingIssues: any[] = [];
  try {
    const res = await fetch(`${options.apiUrl}/api/companies/${options.companyId}/issues?limit=2000`);
    if (res.ok) {
      existingIssues = (await res.json()) as any[];
    }
  } catch {}

  let createdCount = 0;
  let updatedCount = 0;
  let syncedHeadersCount = 0;
  const results: SyncIssueResult[] = [];
  const conflicts: BacklogIdentityConflict[] = [];

  for (const filePath of files) {
    let content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseYamlFrontmatter(content);
    if (!parsed) continue;

    const fields = parsed.fields;
    if (needsWorkPackageFill(fields) && options.workspacePath) {
      const symbolsRaw = fields["target_symbols"];
      const symbols = Array.isArray(symbolsRaw)
        ? symbolsRaw.map(String)
        : typeof symbolsRaw === "string" && symbolsRaw.trim()
          ? [symbolsRaw]
          : [];
      if (symbols.length > 0) {
        const mtimeMs = fs.statSync(filePath).mtimeMs;
        const inferred = cachedInferTargetFiles(filePath, mtimeMs, symbols, options.workspacePath);
        if (inferred.length > 0) {
          fields["target_files"] = [...inferred];
          updateFileFrontmatter(filePath, content, {
            target_files: `[${inferred.map((f) => `"${f}"`).join(", ")}]`,
          });
          content = fs.readFileSync(filePath, "utf-8");
        }
      }
    }
    const filename = path.basename(filePath, ".md");
    const issueId = fields["id"] || fields["identifier"] || filename;
    const title = fields["title"] || filename;
    const priority = (fields["priority"] || fields["severity"] || "medium").toLowerCase();
    const formattedTitle = `[${issueId}] ${title}`;
    const resolvedProject = resolvePaperclipProject({
      workspacePath: options.workspacePath,
      gitRemoteUrl: options.gitRemoteUrl,
      projects: options.projects || [],
      frontmatterProject:
        (typeof fields["project"] === "string" ? fields["project"] : undefined) ||
        (typeof fields["paperclip_project"] === "string" ? fields["paperclip_project"] : undefined),
    });
    const projectId = resolvedProject?.id || options.projectId;

    const declaredPaperclipId = typeof fields["paperclip_issue_id"] === "string"
      ? fields["paperclip_issue_id"].trim()
      : "";
    const resolution = resolveBacklogIssueCandidates(existingIssues, declaredPaperclipId, formattedTitle);
    const declared = resolution.issue;
    const titleCandidates = resolution.candidates;
    if (resolution.declaredMismatch) {
      conflicts.push({
        filePath,
        logicalId: String(issueId),
        candidateIssueIds: Object.freeze([String(resolution.declaredMismatch.id)]),
        reason: `Declared Paperclip issue ${resolution.declaredMismatch.id} has title ${JSON.stringify(resolution.declaredMismatch.title)} instead of ${formattedTitle}`,
      });
      continue;
    }
    // A declared header is authoritative. Without it, an exact title may
    // identify one legacy issue, but multiple candidates are ambiguous and
    // must be quarantined instead of silently attaching to the first match.
    if (!declared && titleCandidates.length > 1) {
      conflicts.push({
        filePath,
        logicalId: String(issueId),
        candidateIssueIds: Object.freeze(titleCandidates.map((i) => String(i.id))),
        reason: `Multiple Paperclip issues have the exact canonical title ${formattedTitle}`,
      });
      continue;
    }
    const existing = declared || titleCandidates[0];

    if (!existing) {
      try {
        const createRes = await fetch(`${options.apiUrl}/api/companies/${options.companyId}/issues`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: options.companyId,
            ...(projectId ? { projectId } : {}),
            title: formattedTitle,
            description: stripPaperclipIdentityMetadata(content),
            priority: priority === "critical" || priority === "high" || priority === "medium" || priority === "low" ? priority : "medium",
            status: "backlog",
            ...(fields["orchestrator_managed"] === "true" && options.orchestratorAgentId
              ? { assigneeAgentId: options.orchestratorAgentId }
              : {}),
          }),
        });

        if (createRes.ok) {
          const newIssue = await createRes.json();
          createdCount++;
          existingIssues.push(newIssue);

          updateFileFrontmatter(filePath, content, {
            paperclip_issue_id: newIssue.id,
            paperclip_identifier: newIssue.identifier || "",
          });
          syncedHeadersCount++;

          results.push({
            filePath,
            issueId,
            title,
            action: "created",
            paperclipId: newIssue.id,
            paperclipIdentifier: newIssue.identifier,
          });
        }
      } catch {}
    } else {
      let action: SyncIssueResult["action"] = "unchanged";
      const sanitizedDescription = stripPaperclipIdentityMetadata(String(existing["description"] ?? ""));
      if (sanitizedDescription !== String(existing["description"] ?? "")) {
        try {
          const descriptionRes = await fetch(`${options.apiUrl}/api/issues/${existing.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ description: sanitizedDescription }),
          });
          if (descriptionRes.ok) {
            existing["description"] = sanitizedDescription;
            updatedCount++;
            action = "updated";
          }
        } catch {
          /* best-effort metadata cleanup; retry on the next sync */
        }
      }
      const orchestratorManaged =
        String(fields["orchestrator_managed"] ?? "").toLowerCase() === "true";
      const managedAgents = options.managedAgentIds ?? new Set<string>();
      const shouldReclaim =
        orchestratorManaged &&
        options.orchestratorAgentId &&
        existing.assigneeAgentId &&
        existing.assigneeAgentId !== options.orchestratorAgentId &&
        !managedAgents.has(existing.assigneeAgentId) &&
        existing.status !== "done" &&
        existing.status !== "cancelled";
      if (shouldReclaim) {
        try {
          const reclaimRes = await fetch(`${options.apiUrl}/api/issues/${existing.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "backlog", assigneeAgentId: options.orchestratorAgentId }),
          });
          if (reclaimRes.ok) {
            existing.status = "backlog";
            existing.assigneeAgentId = options.orchestratorAgentId;
            updatedCount++;
            action = "updated";
          }
        } catch {
          /* best-effort ownership repair; the next tick retries it */
        }
      }
      if (!fields["paperclip_issue_id"] || !fields["paperclip_identifier"]) {
        updateFileFrontmatter(filePath, content, {
          paperclip_issue_id: existing.id,
          paperclip_identifier: existing.identifier || "",
        });
        syncedHeadersCount++;
      }
      if (projectId && existing.projectId !== projectId) {
        try {
          const patchRes = await fetch(`${options.apiUrl}/api/issues/${existing.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId }),
          });
          if (patchRes.ok) {
            existing.projectId = projectId;
            updatedCount++;
            action = "updated";
          }
        } catch {
          /* best-effort project repair */
        }
      }
      results.push({
        filePath,
        issueId,
        title,
        action,
        paperclipId: existing.id,
        paperclipIdentifier: existing.identifier ?? undefined,
      });
    }
  }

  return Object.freeze({
    discoveredCount: files.length,
    createdCount,
    updatedCount,
    syncedHeadersCount,
    results: Object.freeze(results),
    conflicts: Object.freeze(conflicts),
  });
}
