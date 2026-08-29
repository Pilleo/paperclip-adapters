import { ParsedIssueMetadata, CandidateSelection } from "./types.js";

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
    selections.push(
      Object.freeze({
        issue: candidate,
        targetAgentId: vibeAgentId,
        reason: "Routed to Vibe for pre-implementation clarification (code-first research)",
      })
    );
  }

  return Object.freeze(selections);
}

export function buildClarifierAutonomousPrompt(issue: ParsedIssueMetadata): string {
  return `### 🔍 Clarification Task: [${issue.identifier || issue.id}] "${issue.title}"

You are acting as the **Autonomous Clarifier Agent** for this issue.

#### 📋 Protocol & Invariants:
1. **Codebase-First Autonomous Research:**
   - Search the active codebase (using codanna, file_structure, ast-grep, or symbol outline).
   - Consult relevant design docs in \`docs/internals/designs/\` and existing tests.
   - Clarify the open questions listed in \`## ❓ Open Questions\` based on current architectural invariants and kernel constraints.
2. **Autonomous Resolution (Preferred):**
   - If the codebase and design docs provide the necessary answers:
     - Update the issue markdown file in \`docs/internals/backlog/\`.
     - Remove or update \`open_questions: false\` in the YAML frontmatter.
     - Document the technical answers in the \`**Context:**\` or \`**Needed:**\` section.
     - Remove the \`## ❓ Open Questions\` section.
     - Transition issue status to \`todo\`.
3. **Escalate to Operator (Only when impossible to resolve from code):**
   - If and only if the questions involve a business trade-off or missing external operator preference that cannot be deduced from code:
     - Request confirmation / interactive clarification from the operator in Paperclip.`;
}
