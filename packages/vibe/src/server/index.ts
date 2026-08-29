import type { ServerAdapterModule, AdapterExecutionContext, AdapterExecutionResult, AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";
import { createAcpxEngineExecutor } from "@paperclipai/adapter-utils/acpx-engine/execute";
import { VibeConfigSchema, vibeAdapterConfigSchema, DEFAULT_VIBE_COMMAND } from "./config.js";
import { testEnvironment } from "./test-environment.js";
import { VIBE_MODELS } from "./models.js";

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

Integrates Mistral's state-of-the-art **Vibe coding CLI** via the Agent Client Protocol (ACP).

---

## 🚀 Capabilities & Features
- **Local Subprocess Execution:** Runs directly in your workspace with full tool permissions.
- **Instructions Bundle:** Automatically materializes workspace rules, \`AGENTS.md\`, and custom instructions.
- **Skills Studio:** Mounts custom MCP servers and materialized skills into the Vibe subshell.
- **ACP Integration:** Supports bidirectional tool calls, interactive approvals, and real-time streaming logs.

---

## ⚙️ Configuration Parameters

| Parameter | Description | Default |
|---|---|---|
| **Model** | Select Mistral model (\`devstral-small\`, \`mistral-medium-3.5\`, \`devstral-large\`, etc.) | \`mistral-medium-3.5\` |
| **Server Command** | Path or command to invoke the Vibe ACP server | \`vibe --acp\` |
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
  const acpConfig: Record<string, unknown> = {
    ...ctx.config,
    agent: "vibe",
    agentCommand,
    permissionMode: config.permissionMode || "approve-all",
    model: normalizedModel,
    env: {
      ...(typeof rawEnv === "object" && rawEnv !== null ? (rawEnv as Record<string, unknown>) : {}),
      VIBE_ACTIVE_MODEL: normalizedModel,
      VIBE_BYPASS_TOOL_PERMISSIONS: "true",
      ...config.env,
    },
  };

  return await rawAcpExecutor({
    ...ctx,
    config: acpConfig,
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
