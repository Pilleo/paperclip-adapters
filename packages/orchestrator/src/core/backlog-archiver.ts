import fs from "node:fs";
import path from "node:path";
import { scanBacklogDirectory, parseYamlFrontmatter } from "./backlog-sync.js";
import { ParsedIssueMetadata } from "./types.js";

export interface ArchiveResult {
  readonly archivedCount: number;
  readonly archivedFiles: readonly string[];
}

export function archiveResolvedBacklogFiles(
  workspacePath: string,
  allIssues: readonly ParsedIssueMetadata[]
): ArchiveResult {
  const backlogDir = path.join(workspacePath, "docs/internals/backlog");
  const resolvedDir = path.join(backlogDir, "resolved");

  if (!fs.existsSync(backlogDir)) {
    return Object.freeze({ archivedCount: 0, archivedFiles: Object.freeze([]) });
  }

  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true });
  }

  const files = scanBacklogDirectory(backlogDir);
  const doneIssueIds = new Set(
    allIssues
      .filter((i) => i.status === "done")
      .map((i) => i.id)
  );
  const doneIdentifiers = new Set(
    allIssues
      .filter((i) => i.status === "done" && i.identifier)
      .map((i) => i.identifier!.toUpperCase())
  );

  const archivedFiles: string[] = [];

  for (const filePath of files) {
    if (filePath.startsWith(resolvedDir)) continue;

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = parseYamlFrontmatter(content);
      if (!parsed) continue;

      const fields = parsed.fields;
      const paperclipId = fields["paperclip_issue_id"] ? String(fields["paperclip_issue_id"]) : undefined;
      const paperclipIdent = fields["paperclip_identifier"] ? String(fields["paperclip_identifier"]).toUpperCase() : undefined;
      const filename = path.basename(filePath, ".md");
      const rawIssueId = fields["id"] || fields["identifier"] || filename;
      const issueId = String(rawIssueId);

      const isDone =
        (paperclipId && doneIssueIds.has(paperclipId)) ||
        (paperclipIdent && doneIdentifiers.has(paperclipIdent)) ||
        doneIdentifiers.has(issueId.toUpperCase());

      if (isDone) {
        const destPath = path.join(resolvedDir, path.basename(filePath));
        fs.renameSync(filePath, destPath);
        archivedFiles.push(path.basename(filePath));
      }
    } catch {}
  }

  if (archivedFiles.length > 0) {
    try {
      rebuildBacklogReadme(backlogDir);
    } catch {}
  }

  return Object.freeze({
    archivedCount: archivedFiles.length,
    archivedFiles: Object.freeze(archivedFiles),
  });
}

export function rebuildBacklogReadme(backlogDir: string): void {
  const readmePath = path.join(backlogDir, "README.md");
  const files = scanBacklogDirectory(backlogDir);
  const resolvedDir = path.join(backlogDir, "resolved");

  let resolvedCount = 0;
  if (fs.existsSync(resolvedDir)) {
    resolvedCount = fs.readdirSync(resolvedDir).filter((f) => f.endsWith(".md")).length;
  }

  const rows: string[] = [];
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseYamlFrontmatter(content);
    if (!parsed) continue;

    const fields = parsed.fields;
    const filename = path.basename(filePath);
    const issueId = fields["identifier"] || fields["id"] || path.basename(filePath, ".md");
    const title = fields["title"] || "Untitled";
    const priority = fields["priority"] || fields["severity"] || "medium";
    const component = fields["component"] || "general";

    rows.push(`| [${issueId}](${filename}) | ${title} | ${priority} | ${component} |`);
  }

  const readmeContent = `# Mazewall Backlog Index

*Total Active Issues:* ${rows.length} | *Total Resolved Issues:* ${resolvedCount}

| Issue | Title | Priority | Component |
|---|---|---|---|
${rows.join("\n")}
`;

  fs.writeFileSync(readmePath, readmeContent, "utf-8");
}
