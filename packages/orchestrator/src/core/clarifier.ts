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
        reason: "Routed to Vibe for pre-implementation specification & clarification (open_questions)",
      })
    );
  }

  return Object.freeze(selections);
}
