import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseMarkdownFrontmatter } from "./frontmatter.js";
import { parseSymbolTarget, SymbolTarget } from "./linter.js";

export interface DeterministicPlan {
  readonly issueId: string;
  readonly title: string;
  readonly component: string;
  readonly priority: string;
  readonly targetFiles: readonly string[];
  readonly targetSymbols: readonly SymbolTarget[];
  readonly testFiles: readonly string[];
  readonly contextSummary: string;
  readonly neededSummary: string;
  readonly steps: readonly string[];
  readonly semanticSymbolContext?: string | undefined;
  readonly invariantReview?: string | undefined;
}

/**
 * Tier 0: Pure deterministic plan synthesizer (zero-AI, instant, 100% offline).
 */
export function synthesizeDeterministicPlan(
  rawMarkdown: string,
  issueId: string,
  workspacePath?: string
): DeterministicPlan {
  const { frontmatter, content } = parseMarkdownFrontmatter<Record<string, unknown>>(rawMarkdown);

  const title = typeof frontmatter["title"] === "string" ? frontmatter["title"].trim() : issueId;
  const component = typeof frontmatter["component"] === "string" ? frontmatter["component"].trim() : "core";
  const priority = typeof frontmatter["priority"] === "string" ? frontmatter["priority"].trim() : "medium";

  // Target files
  let targetFiles: string[] = [];
  if (Array.isArray(frontmatter["target_files"])) {
    targetFiles = frontmatter["target_files"].filter((f): f is string => typeof f === "string");
  } else if (typeof frontmatter["target_files"] === "string") {
    targetFiles = [frontmatter["target_files"]];
  }

  // Target symbols
  let targetSymbols: SymbolTarget[] = [];
  if (Array.isArray(frontmatter["target_symbols"])) {
    targetSymbols = frontmatter["target_symbols"]
      .filter((s): s is string => typeof s === "string")
      .map(parseSymbolTarget);
  }

  // Discover candidate test files deterministically
  const testFiles: string[] = [];
  for (const f of targetFiles) {
    if (f.includes("/src/main/")) {
      const candidateTest = f.replace("/src/main/", "/src/test/").replace(/\.(kt|java|ts)$/, "Test.$1");
      if (!workspacePath || fs.existsSync(path.join(workspacePath, candidateTest))) {
        testFiles.push(candidateTest);
      }
    }
  }

  // Extract Context & Needed sections
  const contextMatch = content.match(/(?:\*\*Context:\*\*|## Context)([\s\S]*?)(?=\*\*Needed:\*\*|## Needed|##|$)/i);
  const neededMatch = content.match(/(?:\*\*Needed:\*\*|## Needed)([\s\S]*?)(?=##|$)/i);

  const contextSummary = contextMatch?.[1]?.trim() || "No explicit context specified.";
  const neededSummary = neededMatch?.[1]?.trim() || "Implement the fix or feature according to requirements.";

  // Synthesize standard TDD verification steps
  const steps: string[] = [
    `1. **Empirical Reproduction (TDD):** Inspect target files (${targetFiles.join(", ") || "target files"}) and write a reproducer test in ${testFiles[0] || "the test suite"} demonstrating the issue.`,
    `2. **Surgical Implementation:** Apply the requested changes in ${targetFiles.join(", ")} while preserving all architectural and security invariants.`,
    `3. **Verification & Regression Testing:** Run all module tests and ensure zero regressions across the codebase.`,
  ];

  return {
    issueId,
    title,
    component,
    priority,
    targetFiles: Object.freeze(targetFiles),
    targetSymbols: Object.freeze(targetSymbols),
    testFiles: Object.freeze(testFiles),
    contextSummary,
    neededSummary,
    steps: Object.freeze(steps),
  };
}

/**
 * Tier 1: Codanna & Symbol Research Tool (Deterministic symbol outline & caller discovery).
 */
export function enrichPlanWithSymbolResearch(
  plan: DeterministicPlan,
  workspacePath?: string
): DeterministicPlan {
  if (!workspacePath || plan.targetSymbols.length === 0) {
    return plan;
  }

  const symbolNotes: string[] = [];

  for (const target of plan.targetSymbols) {
    const sym = target.methodName || target.className || target.symbol;
    try {
      let output = "";
      try {
        output = execSync(`codanna retrieve describe ${JSON.stringify(sym)}`, {
          cwd: workspacePath,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 4000,
        }).trim();
      } catch (err: any) {
        // If ambiguous, parse candidate symbol_id
        const stdout = String(err.stdout || err.output || "");
        const idMatch = stdout.match(/symbol_id:(\d+)/);
        if (idMatch && idMatch[1]) {
          output = execSync(`codanna retrieve describe symbol_id:${idMatch[1]}`, {
            cwd: workspacePath,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 4000,
          }).trim();
        }
      }

      if (output && !output.includes("No matching")) {
        symbolNotes.push(`#### Symbol: \`${target.symbol}\`\n\`\`\`\n${output.slice(0, 1500)}\n\`\`\``);
      }
    } catch {
      // codanna not installed or symbol not indexed
    }
  }

  const semanticSymbolContext = symbolNotes.length > 0 ? symbolNotes.join("\n\n") : undefined;

  return {
    ...plan,
    semanticSymbolContext,
  };
}

/**
 * Formats the complete implementation plan as a structured Markdown document.
 */
export function formatPlanMarkdown(plan: DeterministicPlan): string {
  const symbolSection =
    plan.targetSymbols.length > 0
      ? `\n\n**Target Methods & Symbols:**\n${plan.targetSymbols.map((s) => `- \`${s.symbol}\``).join("\n")}`
      : "";

  const testSection =
    plan.testFiles.length > 0
      ? `\n\n**Candidate Test Files:**\n${plan.testFiles.map((t) => `- \`${t}\``).join("\n")}`
      : "";

  const codannaSection = plan.semanticSymbolContext
    ? `\n\n### 🔬 Semantic Symbol Research (Codanna)\n\n${plan.semanticSymbolContext}`
    : "";

  return `## 📋 Implementation Plan: ${plan.title}

**Component:** \`${plan.component}\` | **Priority:** \`${plan.priority}\`

**Target Files:**
${plan.targetFiles.map((f) => `- \`${f}\``).join("\n")}${symbolSection}${testSection}

### 💡 Context
${plan.contextSummary}

### 🎯 Needed Steps
${plan.neededSummary}

### 🛠️ Execution Plan (TDD Protocol)
${plan.steps.join("\n\n")}${codannaSection}`;
}
