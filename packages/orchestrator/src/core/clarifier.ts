import { ParsedIssueMetadata, CandidateSelection } from "./types.js";

/**
 * Checks if a task is too broad / monolithic and needs decomposition into smaller, atomic sub-tasks.
 */
export function isTaskTooBroad(issue: ParsedIssueMetadata): { isTooBroad: boolean; reason?: string } {
  // If task explicitly targets more than 5 distinct files across multiple packages
  if (issue.targetFiles && issue.targetFiles.length > 5) {
    const modules = new Set(issue.targetFiles.map((f) => f.split("/")[0]));
    if (modules.size > 1) {
      return {
        isTooBroad: true,
        reason: `Target files span ${issue.targetFiles.length} files across multiple distinct modules (${Array.from(modules).join(", ")}).`,
      };
    }
  }

  const desc = typeof issue.rawIssue["description"] === "string" ? (issue.rawIssue["description"] as string) : "";
  const descLower = desc.toLowerCase();

  // Tasks labeled as multi-part epics or containing multiple independent "Needed" phases
  if (
    descLower.includes("part 1:") &&
    descLower.includes("part 2:") &&
    descLower.includes("part 3:")
  ) {
    return {
      isTooBroad: true,
      reason: "Task description contains multiple independent multi-part execution phases.",
    };
  }

  return { isTooBroad: false };
}

export function needsClarification(issue: ParsedIssueMetadata): boolean {
  const desc = typeof issue.rawIssue["description"] === "string" ? (issue.rawIssue["description"] as string) : "";
  const descLower = desc.toLowerCase();

  if (descLower.includes("open_questions: true") || descLower.includes("openquestions: true")) {
    return true;
  }

  if (desc.includes("## ❓ Open Questions") || desc.includes("## Open Questions")) {
    const sectionMatch = desc.match(/##\s*(?:❓\s*)?Open Questions([\s\S]*?)(?:##|$)/i);
    const qText = sectionMatch?.[1];
    if (qText) {
      const questionsText = qText.trim();
      if (questionsText.length > 10 && !questionsText.toLowerCase().includes("none")) {
        return true;
      }
    }
  }

  if (issue.targetFiles.length === 0 && issue.targetModules.length === 0 && !issue.isNonInterfering) {
    return true;
  }

  if (isTaskTooBroad(issue).isTooBroad) {
    return true;
  }

  return false;
}

export function selectClarificationCandidates(
  backlogIssues: readonly ParsedIssueMetadata[],
  vibeAgentId?: string | undefined,
  maxToSelect = 2
): readonly CandidateSelection[] {
  if (!vibeAgentId) return Object.freeze([]);

  const unassigned = backlogIssues.filter(
    (i) => (i.status === "backlog" || i.status === "todo") && !i.assigneeAgentId && needsClarification(i)
  );

  const sorted = [...unassigned].sort((a, b) => b.priorityRank - a.priorityRank);
  const selections: CandidateSelection[] = [];

  for (const candidate of sorted) {
    if (selections.length >= maxToSelect) break;
    const broadCheck = isTaskTooBroad(candidate);
    const reason = broadCheck.isTooBroad
      ? `Routed for task granularity review & decomposition: ${broadCheck.reason}`
      : "Routed to Vibe for pre-implementation clarification (code-first research)";

    selections.push(
      Object.freeze({
        issue: candidate,
        targetAgentId: vibeAgentId,
        reason,
      })
    );
  }

  return Object.freeze(selections);
}

export function buildClarifierAutonomousPrompt(issue: ParsedIssueMetadata): string {
  const broadCheck = isTaskTooBroad(issue);
  const broadWarning = broadCheck.isTooBroad
    ? `\n⚠️ **SCOPE ALERT**: This task is flagged as potentially too broad (${broadCheck.reason}). Prioritize decomposing this task into smaller atomic sub-tasks.\n`
    : "";

  return `### 🔍 Task Review, Granularity & Pre-Refactoring Gate: [${issue.identifier || issue.id}] "${issue.title}"
${broadWarning}
You are acting as the **Autonomous Task Reviewer & Principal Systems Architect** for this raw upcoming issue.

#### 📋 Mandatory Review Protocol & Architectural Gates:

1. **Task Granularity & Autonomous Splitting Gate (MANDATORY FIRST STEP):**
   - **Is this task truly granular and atomic?** Can a developer agent implement and verify it in a single surgical pass without touching unrelated subsystems?
   - **Autonomous Decomposition:** If the task is too broad (e.g. touches multiple decoupled modules, requires both new FFM downcalls AND full CLI rewrites, or spans >4 target files):
     - **DO NOT** attempt a monolithic implementation.
     - **Split into Sub-Tasks:** Create new standalone issue markdown files in \`docs/internals/backlog/\` (e.g. \`issue-YYYYMMDD-HHMMSS-part-1-types.md\`, \`issue-YYYYMMDD-HHMMSS-part-2-engine.md\`).
     - Link the sub-tasks in sequence with explicit dependencies in frontmatter (\`dependencies: ["MAZ-XXX"]\`).
     - Update the parent issue with a summary of the split and mark it resolved/decomposed.

2. **Pre-Implementation Refactoring & Simplification Gate ("Make the Change Easy First"):**
   - **Is the existing codebase around the target files too complex, tangled, or lacking test seams?**
   - *“Make the change easy (warning: this may be hard), then make the easy change.”*
   - If adding the new feature onto messy legacy code would be risky, brittle, or error-prone:
     - **Spin off a Preparatory Refactoring Sub-Task:** Create a dedicated refactoring issue in \`docs/internals/backlog/\` (e.g. \`issue-*-refactor-*.md\`) to simplify the abstraction, extract clean interfaces, or decouple state FIRST.
     - Make the main feature task depend on the completion of the preparatory refactoring task.

3. **Codebase-First Autonomous Research:**
   - Search the active codebase (using codanna, file_structure, ast-grep, or symbol outline).
   - Consult relevant design docs in \`docs/internals/designs/\` and existing tests.
   - Clarify the open questions listed in \`## ❓ Open Questions\` based on current architectural invariants and kernel constraints.

4. **Autonomous Resolution (Preferred):**
   - If the codebase and design docs provide the necessary answers:
     - Update the issue markdown file in \`docs/internals/backlog/\`.
     - Remove or update \`open_questions: false\` in the YAML frontmatter.
     - Document the technical answers in the \`**Context:**\` or \`**Needed:**\` section.
     - Remove the \`## ❓ Open Questions\` section.
     - Transition issue status to \`todo\`.

5. **Escalate to Operator (Only when impossible to resolve from code):**
   - If and only if the questions involve a business trade-off or missing external operator preference that cannot be deduced from code:
     - Request confirmation / interactive clarification from the operator in Paperclip.`;
}
