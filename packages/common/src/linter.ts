import { parseMarkdownFrontmatter } from "./frontmatter.js";
import { CANONICAL_PRIORITIES } from "./labels.js";

export interface BacklogIssueLintResult {
  readonly isValid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly needsClarification: boolean;
  readonly normalizedMetadata: {
    readonly title?: string | undefined;
    readonly component?: string | undefined;
    readonly priority?: string | undefined;
    readonly severity?: string | undefined;
    readonly targetFiles?: readonly string[] | undefined;
    readonly targetModules?: readonly string[] | undefined;
    readonly openQuestions?: boolean | undefined;
  };
}

export function lintBacklogMarkdown(rawMarkdown: string, filename?: string): BacklogIssueLintResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { frontmatter, content, hasFrontmatter } = parseMarkdownFrontmatter<Record<string, unknown>>(rawMarkdown);

  if (!hasFrontmatter) {
    errors.push("Missing YAML frontmatter block (--- ... ---)");
  }

  // 1. Title validation
  let title = typeof frontmatter["title"] === "string" ? frontmatter["title"].trim() : "";
  if (!title) {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch && headingMatch[1]) {
      title = headingMatch[1].replace(/^[🔴🟡🟢🟠]\s*(?:\[[^\]]+\]:)?\s*/, "").trim();
      warnings.push(`Inferred title from markdown H1: "${title}"`);
    } else {
      errors.push("Missing required field: title");
    }
  }

  // 2. Component validation
  const component = typeof frontmatter["component"] === "string" ? frontmatter["component"].trim().toLowerCase() : "";
  if (!component) {
    warnings.push("Missing component field; defaulting to 'core'");
  }

  // 3. Priority & Severity validation
  let priority = typeof frontmatter["priority"] === "string" ? frontmatter["priority"].trim().toLowerCase() : "";
  const severity = typeof frontmatter["severity"] === "string" ? frontmatter["severity"].trim().toUpperCase() : "";

  if (!priority && severity) {
    priority = severity.toLowerCase();
    warnings.push(`Inferred priority '${priority}' from severity '${severity}'`);
  }

  if (priority && !(CANONICAL_PRIORITIES as readonly string[]).includes(priority)) {
    warnings.push(`Non-standard priority '${priority}'; normalizing to 'medium'`);
    priority = "medium";
  }

  // 4. Target files & modules
  let targetFiles: string[] = [];
  if (Array.isArray(frontmatter["target_files"])) {
    targetFiles = frontmatter["target_files"].filter((f): f is string => typeof f === "string");
  } else if (typeof frontmatter["target_files"] === "string") {
    targetFiles = [frontmatter["target_files"]];
  }

  let targetModules: string[] = [];
  if (Array.isArray(frontmatter["target_modules"])) {
    targetModules = frontmatter["target_modules"].filter((m): m is string => typeof m === "string");
  }

  // 5. Structure validation (Context & Needed)
  const hasContext = content.includes("Context:") || content.includes("## Context") || content.includes("**Context:**");
  const hasNeeded = content.includes("Needed:") || content.includes("## Needed") || content.includes("**Needed:**") || content.includes("## Plan");

  if (!hasContext) {
    warnings.push("Document missing explicit 'Context:' section");
  }
  if (!hasNeeded) {
    warnings.push("Document missing explicit 'Needed:' section");
  }

  // 6. Clarification check
  const openQuestions = frontmatter["open_questions"] === true || content.includes("## ❓ Open Questions") || content.includes("## Open Questions");

  const isValid = errors.length === 0;

  return {
    isValid,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    needsClarification: Boolean(openQuestions),
    normalizedMetadata: {
      title: title || undefined,
      component: component || "core",
      priority: priority || "medium",
      severity: severity || undefined,
      targetFiles: Object.freeze(targetFiles),
      targetModules: Object.freeze(targetModules),
      openQuestions: Boolean(openQuestions),
    },
  };
}
