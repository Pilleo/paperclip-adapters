import { JulesActivity } from "./jules-client.js";
import { PaperclipInteraction } from "./paperclip-client.js";

export const MAX_COMMENT_LENGTH = 3500;
export const MAX_SESSION_RESUME_ATTEMPTS = 4;

export function activityComment(activity: JulesActivity): string | null {
  if (activity.agentMessaged?.agentMessage?.trim()) {
    return `**Message from Jules:**\n\n${activity.agentMessaged.agentMessage.trim()}`;
  }
  if (activity.userMessaged?.userMessage?.trim()) {
    return `**Message sent to Jules:**\n\n${activity.userMessaged.userMessage.trim()}`;
  }
  if (activity.sessionFailed?.reason?.trim()) {
    return `**Jules session failed:**\n\n${activity.sessionFailed.reason.trim()}`;
  }
  if (activity.description?.trim() && !activity.planGenerated && !activity.progressUpdated) {
    return `**Jules:**\n\n${activity.description.trim()}`;
  }
  return null;
}

export function latestAgentMessage(activities: JulesActivity[]): JulesActivity | null {
  return (
    [...activities].reverse().find(
      (activity) => Boolean(activity.agentMessaged?.agentMessage?.trim()) || Boolean(activity.description?.trim())
    ) ?? null
  );
}

export function extractQuestionText(activity: JulesActivity | null): string {
  if (!activity) return "Jules is waiting for feedback. Open the Jules session for the full question.";
  const msg = activity.agentMessaged?.agentMessage?.trim();
  if (msg) return msg;
  const desc = activity.description?.trim();
  if (desc) return desc;
  return "Jules is waiting for feedback. Open the Jules session for the full question.";
}

export function latestPlan(activities: JulesActivity[]): JulesActivity | null {
  return [...activities].reverse().find((activity) => Boolean(activity.planGenerated)) ?? null;
}

export function planMarkdown(activity: JulesActivity | null): string {
  if (activity?.planGenerated?.plan?.steps) {
    const steps = [...activity.planGenerated.plan.steps]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map(
        (step, position) =>
          `${(step.index ?? position) + 1}. **${step.title}**${step.description ? ` — ${step.description}` : ""}`
      )
      .join("\n");
    return `### Jules Implementation Plan\n\n${steps}`;
  }
  return "Jules is waiting for plan approval. Open the Jules session for the generated plan.";
}

export function feedbackAnswer(result: unknown): string | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const answers = (result as Record<string, unknown>)["answers"];
  if (!Array.isArray(answers)) return null;
  for (const answer of answers) {
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) continue;
    const otherText = (answer as Record<string, unknown>)["otherText"];
    if (typeof otherText === "string" && otherText.trim().length > 0) return otherText.trim();
  }
  return null;
}

export function rejectionReason(result: unknown): string | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  for (const key of ["reason", "rejectReason", "rejectionReason", "feedback"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return feedbackAnswer(result);
}

export function interactionPlanRevisionId(interaction: PaperclipInteraction | null): string | null {
  if (!interaction || typeof interaction.target !== "object" || interaction.target === null) return null;
  const target = interaction.target as Record<string, unknown>;
  return target["type"] === "issue_document" && target["key"] === "plan" && typeof target["revisionId"] === "string"
    ? (target["revisionId"] as string)
    : null;
}

export function formatActivityForLog(activity: JulesActivity): string {
  const ts = activity.createTime ? new Date(activity.createTime).toLocaleTimeString() : new Date().toLocaleTimeString();
  const raw = activity as Record<string, unknown>;

  const artifacts = (activity as any)["artifacts"];
  if (Array.isArray(artifacts) && artifacts.length > 0) {
    for (const art of artifacts) {
      if (art.changeSet?.gitPatch?.unidiffPatch) {
        const jsonEvent = JSON.stringify({
          type: "tool_call",
          name: "gitPatch",
          data: art.changeSet.gitPatch.unidiffPatch,
          id: activity.id,
        });
        return jsonEvent + "\n[jules][" + ts + "] Changeset patch applied\n";
      }
    }
  }

  if (activity.planGenerated) {
    const steps = [...(activity.planGenerated.plan?.steps ?? [])]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((step, idx) => "  " + ((step.index ?? idx) + 1) + ". " + step.title + (step.description ? " (" + step.description + ")" : ""))
      .join("\n");
    const jsonEvent = JSON.stringify({
      type: "thought",
      data: "Generated Plan:\n" + steps,
    });
    return jsonEvent + "\n[jules][" + ts + "] Generated Plan:\n" + steps + "\n";
  }

  if (activity.progressUpdated) {
    const desc = activity.progressUpdated.description?.trim();
    const title = activity.progressUpdated.title || "Update";
    const text = title + (desc ? " - " + desc : "");
    const jsonEvent = JSON.stringify({
      type: "text",
      data: text,
    });
    return jsonEvent + "\n[jules][" + ts + "] Progress: " + text + "\n";
  }

  if (activity.agentMessaged) {
    const jsonEvent = JSON.stringify({
      type: "text",
      data: activity.agentMessaged.agentMessage,
    });
    return jsonEvent + "\n[jules][" + ts + "] Agent: " + activity.agentMessaged.agentMessage + "\n";
  }

  if (activity.userMessaged) {
    return "[jules][" + ts + "] User input: " + activity.userMessaged.userMessage + "\n";
  }

  if (raw["bashCodeExecution"] || raw["commandExecution"] || raw["codeExecution"] || raw["toolExecution"]) {
    const b = (raw["bashCodeExecution"] ?? raw["commandExecution"] ?? raw["codeExecution"] ?? raw["toolExecution"]) as Record<string, unknown>;
    const cmd = String(b["command"] ?? b["code"] ?? b["cmd"] ?? "");
    const out = String(b["output"] ?? b["stdout"] ?? b["result"] ?? b["stderr"] ?? "");
    const jsonEvent = JSON.stringify({
      type: "tool_call",
      name: "bash",
      input: { command: cmd },
      output: out,
      id: activity.id,
    });
    return jsonEvent + "\n[jules][" + ts + "] $ " + cmd + "\n" + (out ? out.trim() + "\n" : "");
  }

  if (raw["changeSet"] || raw["fileModifications"] || raw["patch"] || raw["gitPatch"]) {
    const cs = raw["changeSet"] ?? raw["fileModifications"] ?? raw["patch"] ?? raw["gitPatch"];
    const csStr = typeof cs === "string" ? cs : JSON.stringify(cs, null, 2);
    const jsonEvent = JSON.stringify({
      type: "tool_call",
      name: "git_patch",
      input: { diff: csStr },
      id: activity.id,
    });
    return jsonEvent + "\n[jules][" + ts + "] Changeset applied:\n" + csStr + "\n";
  }

  if (activity.sessionCompleted) {
    return "[jules][" + ts + "] Session completed successfully.\n";
  }

  if (activity.sessionFailed) {
    return "[jules][" + ts + "] Session failed: " + activity.sessionFailed.reason + "\n";
  }

  if (activity.description) {
    return "[jules][" + ts + "] " + activity.description + "\n";
  }

  return "[jules][" + ts + "] Activity: " + activity.id + "\n";
}

export function formatPlanCardMarkdown(activity: JulesActivity | null): string {
  if (!activity?.planGenerated?.plan?.steps) {
    return "Jules is waiting for plan approval.";
  }
  const steps = [...activity.planGenerated.plan.steps]
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    .map(
      (step, position) =>
        `- [ ] **Step ${(step.index ?? position) + 1}: ${step.title}**\n  ${step.description ? `> ${step.description}` : ""}`
    )
    .join("\n\n");

  return `<details open>\n<summary><b>📋 Jules Implementation Plan (${activity.planGenerated.plan.steps.length} Steps)</b></summary>\n\n${steps}\n\n</details>`;
}
