/** Guidance for local agents (Vibe, Antigravity). Jules is unrestricted. */
export const LOCAL_AGENT_TOOL_GUIDANCE = `Local-agent tool budget (token-efficient):
- Prefer \`codanna retrieve describe <Symbol>\` and \`codanna retrieve callers <Symbol>\` over opening whole modules.
- Prefer \`git diff\` hunks and named tests over \`cat\` of source files.
- Do not dump entire files into the conversation. Stay inside the plan's target files and symbols.
`;

export function withLocalAgentToolBudget(context: Record<string, unknown>): Record<string, unknown> {
  const existingMarkdown =
    typeof context["paperclipTaskMarkdown"] === "string" ? (context["paperclipTaskMarkdown"] as string) : "";
  const existingDescription =
    typeof context["description"] === "string" ? (context["description"] as string) : "";
  return {
    ...context,
    paperclipTaskMarkdown: existingMarkdown
      ? `${LOCAL_AGENT_TOOL_GUIDANCE}\n\n${existingMarkdown}`
      : LOCAL_AGENT_TOOL_GUIDANCE,
    description: existingDescription
      ? `${LOCAL_AGENT_TOOL_GUIDANCE}\n\n${existingDescription}`
      : LOCAL_AGENT_TOOL_GUIDANCE,
  };
}
