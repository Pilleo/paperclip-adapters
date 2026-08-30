import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cachedInferTargetFiles, needsWorkPackageFill } from "./work-package-ingest.js";
import { resolvePaperclipProject, type PaperclipProjectRecord } from "./parser.js";

export interface BacklogSyncOptions {
  readonly workspacePath: string;
  readonly companyId: string;
  readonly apiUrl: string;
  readonly backlogDirectory?: string | undefined;
  readonly resolvedDirectory?: string | undefined;
  readonly projectId?: string | undefined;
  readonly gitRemoteUrl?: string | undefined;
  readonly projects?: readonly PaperclipProjectRecord[] | undefined;
}

export interface SyncIssueResult {
  readonly filePath: string;
  readonly issueId: string;
  readonly title: string;
  readonly action: "created" | "updated" | "unchanged";
  readonly paperclipId: string;
  readonly paperclipIdentifier?: string | undefined;
}

export interface BacklogSyncSummary {
  readonly discoveredCount: number;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly syncedHeadersCount: number;
  readonly results: readonly SyncIssueResult[];
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

    let existing = existingIssues.find((i) => i.id === fields["paperclip_issue_id"]);
    if (!existing) {
      existing = existingIssues.find(
        (i) => i.title?.startsWith(`[${issueId}]`) || (i.description && i.description.includes(issueId))
      );
    }

    if (!existing) {
      try {
        const createRes = await fetch(`${options.apiUrl}/api/companies/${options.companyId}/issues`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: options.companyId,
            ...(projectId ? { projectId } : {}),
            title: formattedTitle,
            description: content,
            priority: priority === "critical" || priority === "high" || priority === "medium" || priority === "low" ? priority : "medium",
            status: "backlog",
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
      if (!fields["paperclip_issue_id"] || !fields["paperclip_identifier"]) {
        updateFileFrontmatter(filePath, content, {
          paperclip_issue_id: existing.id,
          paperclip_identifier: existing.identifier || "",
        });
        syncedHeadersCount++;
      }
      let action: SyncIssueResult["action"] = "unchanged";
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
        paperclipIdentifier: existing.identifier,
      });
    }
  }

  return Object.freeze({
    discoveredCount: files.length,
    createdCount,
    updatedCount,
    syncedHeadersCount,
    results: Object.freeze(results),
  });
}
