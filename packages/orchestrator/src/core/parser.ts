import path from "node:path";
import { ParsedIssueMetadata, TaskPriority } from "./types.js";
import { normalizeIssueStatus } from "./types.js";

/**
 * Pure parsing functions for task metadata.
 */

export function parsePriorityRank(priorityStr?: string | null): { readonly priority: TaskPriority; readonly rank: number } {
  const p = (priorityStr || "").toLowerCase().trim();
  if (p === "critical" || p === "urgent" || p === "blocker") return { priority: "critical", rank: 4 };
  if (p === "high" || p === "p1") return { priority: "high", rank: 3 };
  if (p === "medium" || p === "p2" || p === "normal") return { priority: "medium", rank: 2 };
  return { priority: "low", rank: 1 };
}

export function parseYamlBool(raw: unknown, defaultValue = false): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return defaultValue;
  const v = raw.replace(/^["']|["']$/g, "").trim().toLowerCase();
  if (v === "true" || v === "yes" || v === "1") return true;
  if (v === "false" || v === "no" || v === "0") return false;
  return defaultValue;
}

export function parseYamlList(raw: unknown): readonly string[] {
  if (Array.isArray(raw)) {
    return Object.freeze(raw.map((item) => String(item).trim()).filter(Boolean));
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return Object.freeze(
        trimmed
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean)
      );
    }
    return Object.freeze([trimmed].filter(Boolean));
  }
  return Object.freeze([]);
}

export function extractIssueMetadata(issue: {
  readonly id: string;
  readonly identifier?: string | null | undefined;
  readonly issueNumber?: number | null | undefined;
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly status: string;
  readonly priority?: string | null | undefined;
  readonly assigneeAgentId?: string | null | undefined;
  readonly [key: string]: unknown;
}): ParsedIssueMetadata {
  const desc = issue.description || "";
  const id = issue.id;
  const identifier = issue.identifier;

  const targetFiles: string[] = [];
  const targetModules: string[] = [];
  const targetSymbols: string[] = [];
  const dependencies: string[] = [];
  let component: string | undefined;
  let projectSlug: string | undefined;
  let priorityStr = issue.priority;
  let hasSideEffects = true;
  let coreLock = false;
  let needsKernel = false;
  let exclusive = false;
  let openQuestions = false;
  let orchestratorManaged = false;
  const verifyCheap: string[] = [];

  // 1. Extract YAML frontmatter
  const firstTriple = desc.indexOf("---");
  if (firstTriple !== -1 && firstTriple < 300) {
    const secondTriple = desc.indexOf("---", firstTriple + 3);
    if (secondTriple !== -1) {
      const frontmatterText = desc.slice(firstTriple + 3, secondTriple);
      const lines = frontmatterText.split("\n");
      let activeListKey: string | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        if (trimmed.startsWith("- ") && activeListKey) {
          const item = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
          if (item) {
            if (activeListKey === "target_files" || activeListKey === "targetfiles") targetFiles.push(item);
            else if (activeListKey === "target_modules" || activeListKey === "targetmodules") targetModules.push(item);
            else if (activeListKey === "target_symbols" || activeListKey === "targetsymbols") targetSymbols.push(item);
            else if (activeListKey === "dependencies" || activeListKey === "depends_on" || activeListKey === "blocked_by") dependencies.push(item);
            else if (activeListKey === "verify_cheap" || activeListKey === "verifycheap") verifyCheap.push(item);
          }
          continue;
        }

        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim();
        activeListKey = key;

        if (key === "target_files" || key === "targetfiles") {
          if (value) targetFiles.push(...parseYamlList(value));
        } else if (key === "target_modules" || key === "targetmodules") {
          if (value) targetModules.push(...parseYamlList(value));
        } else if (key === "target_symbols" || key === "targetsymbols") {
          if (value) targetSymbols.push(...parseYamlList(value));
        } else if (key === "dependencies" || key === "depends_on" || key === "blocked_by") {
          if (value) dependencies.push(...parseYamlList(value));
        } else if (key === "component") {
          component = value.replace(/^["']|["']$/g, "").trim();
        } else if (key === "project" || key === "paperclip_project") {
          projectSlug = value.replace(/^["']|["']$/g, "").trim();
        } else if (key === "priority") {
          priorityStr = value.replace(/^["']|["']$/g, "").trim();
        } else if (key === "has_side_effects" || key === "hassideeffects") {
          hasSideEffects = parseYamlBool(value, true);
        } else if (key === "core_lock" || key === "corelock") {
          coreLock = parseYamlBool(value, false);
        } else if (key === "needs_kernel" || key === "needskernel") {
          needsKernel = parseYamlBool(value, false);
        } else if (key === "exclusive") {
          exclusive = parseYamlBool(value, false);
        } else if (key === "open_questions" || key === "openquestions") {
          openQuestions = parseYamlBool(value, false);
        } else if (key === "orchestrator_managed" || key === "orchestratormanaged") {
          orchestratorManaged = parseYamlBool(value, false);
        } else if (key === "verify_cheap" || key === "verifycheap") {
          if (value) verifyCheap.push(...parseYamlList(value));
        }
      }
    }
  }

  // 2. Markdown tags fallback
  if (targetFiles.length === 0) {
    const tfMatch = desc.match(/(?:target_files|files):\s*\[(.*?)\]/i);
    const tfContent = tfMatch?.[1];
    if (tfContent) {
      targetFiles.push(...tfContent.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
    }
  }
  if (targetModules.length === 0) {
    const tmMatch = desc.match(/(?:target_modules|modules):\s*\[(.*?)\]/i);
    const tmContent = tmMatch?.[1];
    if (tmContent) {
      targetModules.push(...tmContent.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
    }
  }
  if (targetSymbols.length === 0) {
    const tsMatch = desc.match(/(?:target_symbols|symbols):\s*\[(.*?)\]/i);
    const tsContent = tsMatch?.[1];
    if (tsContent) {
      targetSymbols.push(...tsContent.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
    }
  }
  if (dependencies.length === 0) {
    const depMatch = desc.match(/(?:dependencies|depends_on|blocked_by):\s*\[(.*?)\]/i);
    const depContent = depMatch?.[1];
    if (depContent) {
      dependencies.push(...depContent.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
    }
  }

  // Paperclip's first-class blocker edge is authoritative scheduling state.
  // Backlog Markdown may be imported before an upstream issue has an MAZ
  // identifier, so a textual dependency alone cannot safely represent the
  // relationship. Normalize the server IDs into the same dependency set used
  // by the pure dispatcher: an approved start gate authorizes future work but
  // never bypasses an unresolved persisted blocker.
  const rawBlockedBy = issue["blockedBy"];
  if (Array.isArray(rawBlockedBy)) {
    for (const blocker of rawBlockedBy) {
      if (typeof blocker === "string" && blocker.trim()) {
        dependencies.push(blocker.trim());
        continue;
      }
      if (!blocker || typeof blocker !== "object" || Array.isArray(blocker)) continue;
      const blockerId = (blocker as Record<string, unknown>)["id"];
      if (typeof blockerId === "string" && blockerId.trim()) dependencies.push(blockerId.trim());
    }
  }
  const rawBlockedByIds = issue["blockedByIssueIds"];
  if (Array.isArray(rawBlockedByIds)) {
    for (const blockerId of rawBlockedByIds) {
      if (typeof blockerId === "string" && blockerId.trim()) dependencies.push(blockerId.trim());
    }
  }

  const { priority, rank } = parsePriorityRank(priorityStr);
  const idOrIdent = (identifier || id).toLowerCase();
  const isNonInterfering =
    component === "docs" ||
    component === "ci" ||
    idOrIdent.includes("review-task") ||
    idOrIdent.includes("productivity-review");

  if (!openQuestions && /open_questions\s*:\s*true/i.test(desc)) {
    openQuestions = true;
  }
  if (!orchestratorManaged && /orchestrator_managed\s*:\s*true/i.test(desc)) {
    orchestratorManaged = true;
  }

  const executionRunIdRaw = (issue as Record<string, unknown>)["executionRunId"];
  const executionRunId = typeof executionRunIdRaw === "string" && executionRunIdRaw.length > 0 ? executionRunIdRaw : null;
  const parentIdRaw = (issue as Record<string, unknown>)["parentId"];
  const parentId = typeof parentIdRaw === "string" && parentIdRaw.length > 0 ? parentIdRaw : null;
  // These markers are adapter protocol records, never ordinary PR-review
  // tasks. Parent linkage was absent on some historical Paperclip child rows,
  // so marker identity is authoritative for safe exclusion.
  const isDelegatedReviewChild = /<!-- jules-(?:plan-review|question-adjudication):/.test(desc);

  return Object.freeze({
    id,
    identifier: identifier ?? null,
    issueNumber: issue.issueNumber ?? null,
    title: issue.title,
    status: normalizeIssueStatus(issue.status),
    priority,
    priorityRank: rank,
    dependencies: Object.freeze([...new Set(dependencies)]),
    targetFiles: Object.freeze([...new Set(targetFiles)]),
    targetModules: Object.freeze([...new Set(targetModules)]),
    targetSymbols: Object.freeze([...new Set(targetSymbols)]),
    hasSideEffects,
    coreLock,
    needsKernel,
    exclusive,
    verifyCheap: Object.freeze([...new Set(verifyCheap)]),
    component: component ?? null,
    projectSlug: projectSlug ?? null,
    projectId: typeof issue["projectId"] === "string" ? (issue["projectId"] as string) : null,
    isNonInterfering,
    openQuestions,
    orchestratorManaged,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    updatedAt: typeof (issue as Record<string, unknown>)["updatedAt"] === "string" ? ((issue as Record<string, unknown>)["updatedAt"] as string) : null,
    executionRunId,
    parentId,
    isDelegatedReviewChild,
    rawIssue: Object.freeze({ ...issue }),
  });
}

export interface PaperclipProjectRecord {
  readonly id: string;
  readonly name?: string | null | undefined;
  readonly urlKey?: string | null | undefined;
  readonly primaryWorkspace?:
    | { readonly repoUrl?: string | null | undefined; readonly cwd?: string | null | undefined }
    | null
    | undefined;
  readonly codebase?:
    | {
        readonly repoUrl?: string | null | undefined;
        readonly cwd?: string | null | undefined;
        readonly localFolder?: string | null | undefined;
        readonly effectiveLocalFolder?: string | null | undefined;
      }
    | null
    | undefined;
}

export type ProjectWorkspaceResolution =
  | { readonly ok: true; readonly project: PaperclipProjectRecord; readonly workspacePath: string }
  | { readonly ok: false; readonly reason: "missing-project" | "unknown-project" | "missing-workspace"; readonly projectId?: string | undefined };

/**
 * Resolve the checkout from the issue-owned Paperclip project.
 *
 * This deliberately ignores the orchestrator process cwd and git remote. A
 * company heartbeat may service several repositories, so cwd-based inference
 * can silently run a task in the wrong repository.
 */
export function resolveProjectWorkspace(params: {
  readonly projectId?: string | null | undefined;
  readonly projects: readonly PaperclipProjectRecord[];
  /** @deprecated Legacy hints are accepted only to prove they are ignored. */
  readonly workspacePath?: string | undefined;
  /** @deprecated Legacy hints are accepted only to prove they are ignored. */
  readonly gitRemoteUrl?: string | null | undefined;
}): ProjectWorkspaceResolution {
  const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
  if (!projectId) return { ok: false, reason: "missing-project" };

  const project = params.projects.find((candidate) => candidate.id === projectId);
  if (!project) return { ok: false, reason: "unknown-project", projectId };

  const workspacePath = [
    project.primaryWorkspace?.cwd,
    project.codebase?.cwd,
    project.codebase?.effectiveLocalFolder,
    project.codebase?.localFolder,
  ].find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  if (!workspacePath) return { ok: false, reason: "missing-workspace", projectId };

  return { ok: true, project, workspacePath: path.resolve(workspacePath.trim()) };
}

/** owner/repo from a GitHub URL, SSH remote, or already-canonical slug. */
export function normalizeGitHubOwnerRepo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const sshNormalized = trimmed.replace(/^git@github\.com:/i, "github.com/");
  const withoutCredentials = sshNormalized.replace(/^[a-z]+:\/\/[^/@]+@/i, "https://");
  const match = withoutCredentials.match(/(?:github\.com[/:]|^)([^/\s]+)\/([^/#\s]+?)(?:\.git)?$/i);
  if (!match?.[1] || !match[2]) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

function projectRepoSlug(project: PaperclipProjectRecord): string | null {
  return (
    normalizeGitHubOwnerRepo(project.primaryWorkspace?.repoUrl) ||
    normalizeGitHubOwnerRepo(project.codebase?.repoUrl)
  );
}

function projectFolders(project: PaperclipProjectRecord): string[] {
  const raw = [
    project.primaryWorkspace?.cwd,
    project.codebase?.cwd,
    project.codebase?.localFolder,
    project.codebase?.effectiveLocalFolder,
  ];
  return raw
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => path.resolve(value.trim()));
}

/**
 * Pick the Paperclip project for a workspace folder.
 * Folder/cwd and git remote win. Do not map `packages/jules` onto the retired
 * standalone jules-adapter project when the cwd is the adapters monorepo.
 */
export function resolvePaperclipProject(params: {
  readonly workspacePath: string;
  readonly gitRemoteUrl?: string | null | undefined;
  readonly projects: readonly PaperclipProjectRecord[];
  readonly frontmatterProject?: string | null | undefined;
}): PaperclipProjectRecord | null {
  const projects = params.projects.filter((p) => Boolean(p.id));
  if (projects.length === 0) return null;

  const workspace = path.resolve(params.workspacePath);
  const folderSlug = path.basename(workspace).toLowerCase();
  const remote = normalizeGitHubOwnerRepo(params.gitRemoteUrl);

  const front = params.frontmatterProject?.trim();
  if (front) {
    const key = front.toLowerCase();
    const named = projects.find(
      (p) =>
        p.id === front ||
        (p.urlKey || "").toLowerCase() === key ||
        (p.name || "").toLowerCase() === key,
    );
    if (named) return named;
  }

  const cwdHits = projects.filter((p) =>
    projectFolders(p).some((folder) => workspace === folder || workspace.startsWith(`${folder}${path.sep}`)),
  );
  if (cwdHits.length === 1) return cwdHits[0] ?? null;
  if (cwdHits.length > 1) {
    cwdHits.sort((a, b) => {
      const aLen = Math.max(0, ...projectFolders(a).map((f) => f.length));
      const bLen = Math.max(0, ...projectFolders(b).map((f) => f.length));
      return bLen - aLen;
    });
    return cwdHits[0] ?? null;
  }

  if (remote) {
    const byRemote = projects.find((p) => projectRepoSlug(p) === remote);
    if (byRemote) return byRemote;
  }

  const byName = projects.find(
    (p) => (p.name || "").toLowerCase() === folderSlug || (p.urlKey || "").toLowerCase() === folderSlug,
  );
  return byName ?? null;
}
