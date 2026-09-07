import type { ServerAdapterModule, AdapterExecutionContext, AdapterExecutionResult, AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";
import path from "node:path";
import { createAcpxEngineExecutor } from "@paperclipai/adapter-utils/acpx-engine/execute";
import { VibeConfigSchema, vibeAdapterConfigSchema, DEFAULT_VIBE_COMMAND } from "./config.js";
import { testEnvironment } from "./test-environment.js";
import { VIBE_MODELS } from "./models.js";
import { LOCAL_AGENT_TOOL_GUIDANCE, withLocalAgentToolBudget } from "@pilleo/paperclip-adapter-common";

export const type = "vibe";
export const label = "Mistral Vibe Code";
export const models = VIBE_MODELS;

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Devstral Small without reasoning as the budget Mistral Vibe lane.",
    adapterConfig: {
      model: "devstral-small",
      thinking: "off",
    },
    source: "adapter_default",
  },
];

export const vibeAgentConfigurationDoc = `# Mistral Vibe Code Adapter

Integrates Mistral's state-of-the-art **Vibe coding CLI** via the Agent Client Protocol (\`vibe-acp\`).

---

## 🚀 Capabilities & Features
- **Native ACP Server:** Runs \`vibe-acp\` directly with bidirectional tool communication.
- **Instructions Bundle:** Automatically materializes workspace rules, \`AGENTS.md\`, and custom instructions.
- **Skills Studio:** Mounts custom MCP servers and materialized skills into the Vibe subshell.
- **ACP Integration:** Supports bidirectional tool calls, interactive approvals, and real-time streaming logs.
- **Token-efficient tools:** Prefer Codanna symbol outlines, git diff hunks, and named tests over dumping whole files.

---

## ⚙️ Configuration Parameters

| Parameter | Description | Default |
|---|---|---|
| **Model** | Select Mistral model (\`devstral-small\`, \`mistral-medium-3.5\`, \`devstral-large\`, etc.) | \`mistral-medium-3.5\` |
| **Server Command** | Path or command to invoke the Vibe ACP server | \`vibe-acp\` |
| **Permission Mode** | Tool execution policy (\`approve-all\`, \`prompt-on-write\`, \`read-only\`) | \`approve-all\` |
| **Environment Variables** | Custom environment variables passed to the Vibe process (e.g. \`MISTRAL_API_KEY\`) | \`{}\` |

---

## 🔑 Authentication
Provide your \`MISTRAL_API_KEY\` either in the environment bindings or directly in the adapter configuration.
`;

const rawAcpExecutor = createAcpxEngineExecutor({ adapterType: "vibe" });

function normalizeVibeModel(rawModel?: string): string {
  if (!rawModel) return "mistral-medium-3.5";
  const cleaned = rawModel.replace(/-(high|medium|low|max|off)$/, "");
  return cleaned.trim() || "mistral-medium-3.5";
}

function paperclipIssueId(ctx: AdapterExecutionContext): string | undefined {
  const context = (ctx.context ?? {}) as Record<string, unknown>;
  const directTask = context["task"];
  if (directTask && typeof directTask === "object" && typeof (directTask as Record<string, unknown>)["id"] === "string") {
    return (directTask as Record<string, unknown>)["id"] as string;
  }
  const issue = context["paperclipIssue"];
  if (issue && typeof issue === "object" && typeof (issue as Record<string, unknown>)["id"] === "string") {
    return (issue as Record<string, unknown>)["id"] as string;
  }
  const wake = context["paperclipWake"];
  const wakeIssue = wake && typeof wake === "object" ? (wake as Record<string, unknown>)["issue"] : undefined;
  return wakeIssue && typeof wakeIssue === "object" && typeof (wakeIssue as Record<string, unknown>)["id"] === "string"
    ? (wakeIssue as Record<string, unknown>)["id"] as string
    : undefined;
}

const READ_ONLY_REVIEW_DIRECTIVE = `\n\n## Execution role: pull-request reviewer\nThis task has already been implemented. Review the linked pull request; do not implement the task.\n\nThe workspace is sandboxed. Do not edit files, create commits, push branches, or open PRs. Your assigned Paperclip **review dialog** is the only authoritative response surface. Resolve its single pull-request item through the Paperclip interaction/verdict tool:\n- choose **approve** only when all is good;\n- choose **reject** when work is needed, with a concrete mandatory reason.\n\nDo not post a review disposition in an issue comment and do not use PAPERCLIP_REVIEW_DECISION. If the dialog is absent or cannot be resolved, report that operational failure without inventing a verdict.\n`;
const PLAN_REVIEW_DIRECTIVE = "\\n\\n## Execution role: Jules plan reviewer\\nThis is a delegated plan-review task, not a pull-request review. Do not implement changes, create commits, or ask a human. Inspect the parent Jules plan and return exactly one raw JSON object as the first line of a Paperclip comment. Use only the decision allowed by the stage marker: PASS_TO_STRONG or REQUEST_REVISION for the fast stage; APPROVE, REQUEST_REVISION, or ESCALATE for the strong stage. The parent Jules worker consumes this explicit protocol message. Do not use PAPERCLIP_REVIEW_DECISION and do not rely on changing the issue status.\\n";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const parsed = VibeConfigSchema.safeParse(ctx.config ?? {});
  const config = parsed.success ? parsed.data : VibeConfigSchema.parse({});

  const agentCommand = config.serverCommand || DEFAULT_VIBE_COMMAND;
  const normalizedModel = normalizeVibeModel(config.model);

  const rawEnv = ctx.config ? ctx.config["env"] : undefined;
  const permissionMode = config.permissionMode || "approve-all";
  const issueId = paperclipIssueId(ctx);
  const isReadOnlyReviewer = permissionMode === "read-only" && /review/i.test(ctx.agent?.name ?? "");
  const taskMarkdown = String((ctx.context as Record<string, unknown> | undefined)?.["paperclipTaskMarkdown"] ?? "");
  const isPlanReviewer = isReadOnlyReviewer && (
    taskMarkdown.includes("<!-- paperclip-delegation kind=jules-plan-review") ||
    taskMarkdown.includes("<!-- jules-plan-review:")
  );
  // ACPX rejects relative sandbox roots. Paperclip workers may start with a
  // repository-relative cwd, so normalize before exporting the sandbox path.
  const reviewCwd = path.resolve(config.cwd || process.cwd());
  // The local Paperclip image currently lacks the `/bin` mount point required
  // by the workspace Bubblewrap profile. Keep the reviewer network-isolated;
  // read-only enforcement remains in the reviewer prompt/agent permissions.
  const filesystemScope = isReadOnlyReviewer ? null : null;
  const networkScope = isReadOnlyReviewer ? (config.networkScope ?? "allowlist") : null;
  const networkAllowlist = config.networkAllowlist ?? ["api.mistral.ai"];
  const mergedEnv: Record<string, unknown> = {
    ...(typeof rawEnv === "object" && rawEnv !== null ? (rawEnv as Record<string, unknown>) : {}),
    VIBE_ACTIVE_MODEL: normalizedModel,
    ...config.env,
    ...(issueId ? { PAPERCLIP_TASK_ID: issueId, PAPERCLIP_ISSUE_ID: issueId } : {}),
    ...(isReadOnlyReviewer ? { PAPERCLIP_REVIEW_MODE: "true" } : {}),
    ...(isReadOnlyReviewer ? { HOME: reviewCwd } : {}),
  };
  if (permissionMode === "approve-all") {
    mergedEnv["VIBE_BYPASS_TOOL_PERMISSIONS"] = "true";
  } else {
    delete mergedEnv["VIBE_BYPASS_TOOL_PERMISSIONS"];
  }
  const acpConfig: Record<string, unknown> = {
    ...ctx.config,
    agent: "custom",
    // The managed reviewer uses Vibe's native read-only permission mode.
    // Adapter-owned Bubblewrap is intentionally disabled until the Paperclip
    // local image consistently provides the mount targets it requires.
    agentCommand,
    permissionMode,
    model: normalizedModel,
    ...(isReadOnlyReviewer ? { cwd: reviewCwd } : {}),
    // ACPX maps thinkingEffort to the generic `effort` session option. Vibe
    // ACP advertises `thinking` instead and rejects that option, which makes a
    // review worker fail before it can read the PR. Until ACPX supports an
    // adapter-specific option mapping, omit this incompatible override and let
    // Vibe use its server-side default.
    timeoutSec: config.timeoutSec,
    env: mergedEnv,
  };
  // Remove incompatible thinking config options that Vibe ACP doesn't support
  delete acpConfig["thinking"];
  delete acpConfig["thinkingEffort"];
  delete acpConfig["effort"];
  if (isReadOnlyReviewer) {
    delete acpConfig["filesystemScope"];
    delete acpConfig["networkScope"];
    delete acpConfig["localProcessSandbox"];
  }

  const reviewContext = isReadOnlyReviewer
    ? {
        ...(ctx.context || {}),
        paperclipTaskMarkdown: `${taskMarkdown}${isPlanReviewer ? PLAN_REVIEW_DIRECTIVE : READ_ONLY_REVIEW_DIRECTIVE}`,
        // ACPX gives paperclipWorkspace.cwd precedence over config.cwd. Board
        // wakeups can carry a relative workspace cwd, which fails ACPX before
        // this adapter's launcher is reached; normalize the injected context.
        ...(() => {
          const workspace = (ctx.context as Record<string, unknown> | undefined)?.["paperclipWorkspace"];
          if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return {};
          return { paperclipWorkspace: { ...(workspace as Record<string, unknown>), cwd: reviewCwd } };
        })(),
      }
    : ctx.context;

  return await rawAcpExecutor({
    ...ctx,
    context: withLocalAgentToolBudget((reviewContext || {}) as Record<string, unknown>),
    config: {
      ...acpConfig,
      promptTemplate:
        typeof acpConfig["promptTemplate"] === "string"
          ? `${LOCAL_AGENT_TOOL_GUIDANCE}\n\n${acpConfig["promptTemplate"]}`
          : acpConfig["promptTemplate"],
    },
  });
}

export { testEnvironment };

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    models,
    modelProfiles,
    execute,
    testEnvironment,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
    agentConfigurationDoc: vibeAgentConfigurationDoc,
    getConfigSchema: () => vibeAdapterConfigSchema,
  };
}

export default createServerAdapter;
