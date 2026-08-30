import fs from "node:fs";
import path from "node:path";
import { parseMarkdownFrontmatter } from "./frontmatter.js";

export const VALID_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "ENHANCEMENT"] as const;
export type ValidSeverity = (typeof VALID_SEVERITIES)[number];

export const VALID_STATUSES = ["open", "in_progress", "resolved", "deferred"] as const;
export type ValidStatus = (typeof VALID_STATUSES)[number];

export const VALID_COMPONENTS = [
  "enforcer",
  "profiler",
  "orchestrator",
  "docs",
  "ci",
  "testing",
  "platform",
  "core",
  "tools",
] as const;

export const VALID_GRADLE_MODULES = [
  ":platform",
  ":enforcer",
  ":profiler",
  ":portal",
  ":portal-codegen",
  ":portal-worker",
  ":demos:cli-demo",
  ":demos:vulnerable-web-app",
  ":demos:agent-sandbox-demo",
  ":tools:orchestrator",
] as const;

/** npm workspaces in this adapters monorepo (planning tool is not mazewall-only). */
export const VALID_NPM_WORKSPACES = [
  "packages/common",
  "packages/jules",
  "packages/orchestrator",
  "packages/vibe",
  "packages/antigravity",
  "packages/telegram",
] as const;

export function isValidTargetModule(mod: string): boolean {
  const trimmed = mod.trim();
  if ((VALID_GRADLE_MODULES as readonly string[]).includes(trimmed)) return true;
  if ((VALID_NPM_WORKSPACES as readonly string[]).includes(trimmed)) return true;
  if (/^@pilleo\/paperclip-[a-z0-9-]+$/.test(trimmed)) return true;
  return false;
}

export const VALID_FILENAME_PATTERN = /^issue-(?:\d{8}[-_]\d{6}(?:[-_]\d{2})?|\d{8}[-_]\d{2,4}|\d{1,4})[-_][a-z0-9_-]+\.md$/;

export interface SymbolTarget {
  readonly symbol: string;
  readonly className?: string | undefined;
  readonly methodName?: string | undefined;
}

export function parseSymbolTarget(raw: string): SymbolTarget {
  const trimmed = raw.trim();
  if (trimmed.includes("#")) {
    const parts = trimmed.split("#");
    return {
      symbol: trimmed,
      className: parts[0]?.trim() || undefined,
      methodName: parts[1]?.trim() || undefined,
    };
  }
  if (trimmed.includes(".")) {
    const parts = trimmed.split(".");
    const last = parts[parts.length - 1];
    return {
      symbol: trimmed,
      className: parts.slice(0, -1).join(".") || undefined,
      methodName: last || undefined,
    };
  }
  return { symbol: trimmed };
}

/** Canonical lock key so `Foo#bar` and `Foo.bar` collide. */
export function symbolLockKey(raw: string): string {
  const parsed = parseSymbolTarget(raw);
  if (parsed.className && parsed.methodName) {
    return `${parsed.className}#${parsed.methodName}`;
  }
  return parsed.symbol;
}

export interface BacklogIssueLintResult {
  readonly isValid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly needsClarification: boolean;
  readonly normalizedMetadata: {
    readonly id?: string | undefined;
    readonly title?: string | undefined;
    readonly component?: string | undefined;
    readonly priority?: string | undefined;
    readonly severity?: ValidSeverity | undefined;
    readonly status?: ValidStatus | undefined;
    readonly targetModules?: readonly string[] | undefined;
    readonly targetFiles?: readonly string[] | undefined;
    readonly targetSymbols?: readonly string[] | undefined;
    readonly openQuestions?: boolean | undefined;
    readonly dependencies?: readonly string[] | undefined;
  };
}

export function lintBacklogMarkdown(
  rawMarkdown: string,
  filename?: string,
  knownIssueIds?: ReadonlySet<string>,
  isInsideResolvedDir = false
): BacklogIssueLintResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Filename validation
  if (filename && !VALID_FILENAME_PATTERN.test(filename)) {
    errors.push(
      `Invalid filename format '${filename}'. Date-based issue filenames must follow 'issue-YYYYMMDD-HHMMSS-slug.md'`
    );
  }

  // 2. YAML frontmatter header
  if (!rawMarkdown.trimStart().startsWith("---")) {
    errors.push("Missing YAML frontmatter header (must start with '---')");
    return {
      isValid: false,
      errors: Object.freeze(errors),
      warnings: Object.freeze(warnings),
      needsClarification: false,
      normalizedMetadata: {},
    };
  }

  const { frontmatter, content, hasFrontmatter } = parseMarkdownFrontmatter<Record<string, unknown>>(rawMarkdown);
  if (!hasFrontmatter) {
    errors.push("Failed to parse YAML frontmatter block");
    return {
      isValid: false,
      errors: Object.freeze(errors),
      warnings: Object.freeze(warnings),
      needsClarification: false,
      normalizedMetadata: {},
    };
  }

  // 3. Title validation
  const title = typeof frontmatter["title"] === "string" ? frontmatter["title"].trim() : "";
  if (!title) {
    errors.push("Missing or empty 'title' in frontmatter");
  }

  // 4. Severity validation
  let severity: ValidSeverity | undefined = undefined;
  if (typeof frontmatter["severity"] === "string") {
    const upper = frontmatter["severity"].trim().toUpperCase();
    if ((VALID_SEVERITIES as readonly string[]).includes(upper)) {
      severity = upper as ValidSeverity;
    } else {
      errors.push(`Invalid severity '${frontmatter["severity"]}'. Allowed: ${VALID_SEVERITIES.join(", ")}`);
    }
  }

  // 5. Status validation
  let status: ValidStatus = "open";
  if (typeof frontmatter["status"] === "string") {
    const lower = frontmatter["status"].trim().toLowerCase();
    if ((VALID_STATUSES as readonly string[]).includes(lower)) {
      status = lower as ValidStatus;
    } else {
      errors.push(`Invalid status '${frontmatter["status"]}'. Allowed: ${VALID_STATUSES.join(", ")}`);
    }
  }

  if (isInsideResolvedDir && status !== "resolved") {
    errors.push(`Issue is located in 'resolved/' directory but has status '${status}' (expected 'resolved')`);
  } else if (!isInsideResolvedDir && status === "resolved") {
    errors.push(`Issue has status 'resolved' but is located outside the 'resolved/' directory`);
  }

  // 6. Priority validation
  let priority = typeof frontmatter["priority"] === "string" ? frontmatter["priority"].trim().toLowerCase() : "";
  if (!priority && severity) {
    priority = severity === "ENHANCEMENT" ? "low" : severity.toLowerCase();
  }

  // 7. Component validation
  const component = typeof frontmatter["component"] === "string" ? frontmatter["component"].trim().toLowerCase() : "";
  if (!component) {
    errors.push(`Missing 'component' field in frontmatter. Allowed: ${VALID_COMPONENTS.join(", ")}`);
  } else if (!(VALID_COMPONENTS as readonly string[]).includes(component)) {
    errors.push(`Invalid component '${component}'. Allowed: ${VALID_COMPONENTS.join(", ")}`);
  }

  // 8. Target modules validation
  let targetModules: string[] = [];
  if (Array.isArray(frontmatter["target_modules"])) {
    targetModules = frontmatter["target_modules"].filter((m): m is string => typeof m === "string");
  }
  if (targetModules.length === 0 && (status === "open" || status === "in_progress")) {
    errors.push(
      "'target_modules' must contain at least one Gradle module (e.g. [':enforcer']) or npm workspace (e.g. ['packages/jules'])",
    );
  } else {
    for (const mod of targetModules) {
      if (!isValidTargetModule(mod)) {
        errors.push(
          `Invalid target module '${mod}'. Allowed Gradle: ${VALID_GRADLE_MODULES.join(", ")}; npm workspaces: ${VALID_NPM_WORKSPACES.join(", ")} or @pilleo/paperclip-*`,
        );
      }
    }
  }

  // 9. Target files & symbols validation (Method-level granularity)
  let targetFiles: string[] = [];
  if (Array.isArray(frontmatter["target_files"])) {
    targetFiles = frontmatter["target_files"].filter((f): f is string => typeof f === "string");
  }
  if (targetFiles.length === 0 && (status === "open" || status === "in_progress")) {
    errors.push("'target_files' must contain at least one file path for open/in_progress issues");
  }

  let targetSymbols: string[] = [];
  if (Array.isArray(frontmatter["target_symbols"])) {
    targetSymbols = frontmatter["target_symbols"].filter((s): s is string => typeof s === "string");
  }

  // 10. Section validation (Context and Needed)
  const hasContext = content.includes("Context:") || content.includes("## Context") || content.includes("**Context:**");
  const hasNeeded = content.includes("Needed:") || content.includes("## Needed") || content.includes("**Needed:**");

  if (!hasContext) {
    errors.push("Missing required 'Context:' section in issue body");
  }
  if (!hasNeeded) {
    errors.push("Missing required 'Needed:' section in issue body");
  }

  // 11. Open Questions validation
  const rawOpenQuestions = frontmatter["open_questions"];
  const hasOpenQuestionsSection = content.includes("## ❓ Open Questions") || content.includes("## Open Questions");
  let openQuestions = false;

  if (rawOpenQuestions === true) {
    openQuestions = true;
    if (!hasOpenQuestionsSection) {
      errors.push("Declares 'open_questions: true' in frontmatter but is missing a non-empty '## ❓ Open Questions' section");
    }
  } else if (rawOpenQuestions === false) {
    openQuestions = false;
    if (hasOpenQuestionsSection) {
      errors.push("Declares 'open_questions: false' in frontmatter but contains an 'Open Questions' section in body");
    }
  } else if (hasOpenQuestionsSection) {
    errors.push("Contains an 'Open Questions' section in body but frontmatter is missing 'open_questions: true'");
    openQuestions = true;
  }

  // 12. Dependencies validation
  let dependencies: string[] = [];
  if (Array.isArray(frontmatter["dependencies"])) {
    dependencies = frontmatter["dependencies"].filter((d): d is string => typeof d === "string");
    if (knownIssueIds) {
      for (const dep of dependencies) {
        if (dep.trim() && !knownIssueIds.has(dep.trim())) {
          errors.push(`References non-existent dependency '${dep}'`);
        }
      }
    }
  }

  const isValid = errors.length === 0;

  return {
    isValid,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    needsClarification: openQuestions,
    normalizedMetadata: {
      id: filename ? filename.replace(/\.md$/, "") : undefined,
      title: title || undefined,
      component: component || undefined,
      priority: priority || undefined,
      severity,
      status,
      targetModules: Object.freeze(targetModules),
      targetFiles: Object.freeze(targetFiles),
      targetSymbols: Object.freeze(targetSymbols),
      openQuestions,
      dependencies: Object.freeze(dependencies),
    },
  };
}

function findIssueFilesRecursively(dir: string): Array<{ filePath: string; fileName: string; isResolved: boolean }> {
  const results: Array<{ filePath: string; fileName: string; isResolved: boolean }> = [];
  if (!fs.existsSync(dir)) return results;

  function traverse(current: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        traverse(fullPath);
      } else if (entry.isFile() && entry.name.startsWith("issue-") && entry.name.endsWith(".md")) {
        const isResolved = fullPath.includes(`${path.sep}resolved${path.sep}`) || fullPath.endsWith(`${path.sep}resolved`);
        results.push({ filePath: fullPath, fileName: entry.name, isResolved });
      }
    }
  }

  traverse(dir);
  return results;
}

export function validateBacklogDirectory(backlogDir: string): {
  readonly totalIssues: number;
  readonly validCount: number;
  readonly errors: ReadonlyArray<{ readonly file: string; readonly message: string }>;
} {
  if (!fs.existsSync(backlogDir)) {
    return {
      totalIssues: 0,
      validCount: 0,
      errors: [{ file: backlogDir, message: "Directory does not exist" }],
    };
  }

  const allFiles = findIssueFilesRecursively(backlogDir);
  const allErrors: Array<{ file: string; message: string }> = [];
  let validCount = 0;

  for (const { filePath, fileName, isResolved } of allFiles) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const res = lintBacklogMarkdown(content, fileName, undefined, isResolved);
      if (res.isValid) {
        validCount++;
      } else {
        const rel = path.relative(backlogDir, filePath);
        for (const err of res.errors) {
          allErrors.push({ file: rel, message: err });
        }
      }
    } catch (e: unknown) {
      allErrors.push({ file: fileName, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    totalIssues: allFiles.length,
    validCount,
    errors: Object.freeze(allErrors),
  };
}
