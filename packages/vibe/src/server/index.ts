import type { ServerAdapterModule, AdapterExecutionContext, AdapterExecutionResult, AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";
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

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const parsed = VibeConfigSchema.safeParse(ctx.config ?? {});
  const config = parsed.success ? parsed.data : VibeConfigSchema.parse({});

  const agentCommand = config.serverCommand || DEFAULT_VIBE_COMMAND;
  const normalizedModel = normalizeVibeModel(config.model);

  const rawEnv = ctx.config ? ctx.config["env"] : undefined;
  const permissionMode = config.permissionMode || "approve-all";
  const mergedEnv: Record<string, unknown> = {
    ...(typeof rawEnv === "object" && rawEnv !== null ? (rawEnv as Record<string, unknown>) : {}),
    VIBE_ACTIVE_MODEL: normalizedModel,
    ...config.env,
  };
  if (permissionMode === "approve-all") {
    mergedEnv["VIBE_BYPASS_TOOL_PERMISSIONS"] = "true";
  } else {
    delete mergedEnv["VIBE_BYPASS_TOOL_PERMISSIONS"];
  }
  const acpConfig: Record<string, unknown> = {
    ...ctx.config,
    agent: "custom",
    agentCommand,
    permissionMode,
    model: normalizedModel,
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

  return await rawAcpExecutor({
    ...ctx,
    context: withLocalAgentToolBudget((ctx.context || {}) as Record<string, unknown>),
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
