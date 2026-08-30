import path from "node:path";
import type { ServerAdapterModule, AdapterExecutionContext, AdapterExecutionResult, AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";
import { createAcpxEngineExecutor } from "@paperclipai/adapter-utils/acpx-engine/execute";
import { AntigravityConfigSchema, antigravityAdapterConfigSchema, DEFAULT_AGY_SERVER_PATH } from "./config.js";
import { testEnvironment } from "./test-environment.js";
import { ANTIGRAVITY_MODELS } from "../ui/models.js";
import { fetchDynamicAntigravityModels } from "./discover-models.js";
import { LOCAL_AGENT_TOOL_GUIDANCE, withLocalAgentToolBudget } from "@pilleo/paperclip-adapter-common";

export const type = "antigravity";
export const label = "Google Antigravity (AGY)";
export const models = ANTIGRAVITY_MODELS;

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Gemini 3.5 Flash as the budget Antigravity reasoning lane.",
    adapterConfig: {
      model: "gemini-3.5-flash-extra-low",
    },
    source: "adapter_default",
  },
];

export const antigravityAgentConfigurationDoc = `# Google Antigravity (AGY) Adapter

Runs **Google Antigravity** pair-programming agent sessions via the Agent Client Protocol (ACP) over stdio.

---

## 🚀 Capabilities & Features
- **Pair-Programming Agent Engine:** Native Google DeepMind Antigravity agent integration.
- **Instructions Bundle:** Automatically materializes workspace rules, \`AGENTS.md\`, and custom instructions.
- **Skills Studio:** Mounts custom MCP servers and materialized skills into the AGY subshell.
- **ACP Integration:** Supports bidirectional tool calls, interactive approvals, and real-time streaming logs.
- **Token-efficient tools:** Prefer Codanna symbol outlines, git diff hunks, and named tests over dumping whole files.

---

## ⚙️ Configuration Parameters

| Parameter | Description | Default |
|---|---|---|
| **Model** | Select Gemini model (\`gemini-pro-agent\`, \`gemini-3-flash-agent\`, \`gemini-3.5-flash-low\`, etc.) | \`gemini-pro-agent\` |
| **Server Path** | Path to the \`agy\` or \`antigravity\` binary | \`~/.local/bin/agy\` |
| **Permission Mode** | Tool execution policy (\`approve-all\`, \`prompt-on-write\`, \`read-only\`) | \`approve-all\` |
| **UID / Debug** | Optional user ID isolation and ACP debug trace flags | \`--uid=\` |
`;

const rawAcpExecutor = createAcpxEngineExecutor({ adapterType: "antigravity" });

function normalizeAntigravityModel(rawModel?: string): string {
  if (!rawModel) return "gemini-pro-agent";
  const m = rawModel.trim();
  if (m === "gemini-3.1-pro-high" || m === "gemini-3.1-pro" || m === "gemini-pro") return "gemini-pro-agent";
  if (m === "gemini-3.5-flash-high" || m === "gemini-3.5-flash") return "gemini-3-flash-agent";
  if (m === "gemini-3.5-flash-medium") return "gemini-3.5-flash-low";
  if (m === "gemini-3.5-flash-low") return "gemini-3.5-flash-extra-low";
  return m;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const parsed = AntigravityConfigSchema.safeParse(ctx.config ?? {});
  const config = parsed.success ? parsed.data : AntigravityConfigSchema.parse({});

  const rawServer = config.serverPath || DEFAULT_AGY_SERVER_PATH;
  const serverPath =
    rawServer.includes("/") || rawServer.startsWith(".")
      ? path.resolve(rawServer)
      : rawServer;
  const debugArg = config.debug ? " --debug" : "";
  const uidArg = config.uid !== undefined && config.uid !== null ? ` --uid=${config.uid}` : " --uid=";
  const agentCommand = `${serverPath}${uidArg}${debugArg}`;
  const normalizedModel = normalizeAntigravityModel(config.model);

  const acpConfig: Record<string, unknown> = {
    ...ctx.config,
    agent: "antigravity",
    agentCommand,
    permissionMode: config.permissionMode || "approve-all",
    model: normalizedModel,
    timeoutSec: config.timeoutSec,
  };

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
    type: "antigravity",
    execute,
    testEnvironment,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
    models: ANTIGRAVITY_MODELS,
    modelProfiles,
    listModels: async () => await fetchDynamicAntigravityModels(),
    listModelProfiles: async () => modelProfiles,
    agentConfigurationDoc: antigravityAgentConfigurationDoc,
    getConfigSchema: () => antigravityAdapterConfigSchema,
  };
}

export default createServerAdapter;
