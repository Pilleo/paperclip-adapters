import { ParsedIssueMetadata, TaskPriority } from "./types.js";

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
  let priorityStr = issue.priority;
  let hasSideEffects = true;

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
        } else if (key === "priority") {
          priorityStr = value.replace(/^["']|["']$/g, "").trim();
        } else if (key === "has_side_effects" || key === "hassideeffects") {
          hasSideEffects = value.replace(/^["']|["']$/g, "").trim().toLowerCase() !== "false";
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

  const { priority, rank } = parsePriorityRank(priorityStr);
  const idOrIdent = (identifier || id).toLowerCase();
  const isNonInterfering =
    component === "docs" ||
    component === "ci" ||
    idOrIdent.includes("review-task") ||
    idOrIdent.includes("productivity-review");

  return Object.freeze({
    id,
    identifier: identifier ?? null,
    issueNumber: issue.issueNumber ?? null,
    title: issue.title,
    status: issue.status,
    priority,
    priorityRank: rank,
    dependencies: Object.freeze([...new Set(dependencies)]),
    targetFiles: Object.freeze([...new Set(targetFiles)]),
    targetModules: Object.freeze([...new Set(targetModules)]),
    targetSymbols: Object.freeze([...new Set(targetSymbols)]),
    hasSideEffects,
    component: component ?? null,
    isNonInterfering,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    updatedAt: typeof (issue as Record<string, unknown>)["updatedAt"] === "string" ? ((issue as Record<string, unknown>)["updatedAt"] as string) : null,
    rawIssue: Object.freeze({ ...issue }),
  });
}
