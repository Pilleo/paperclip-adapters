import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerAdapterModule, AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createAcpxEngineExecutor } from "@paperclipai/adapter-utils/acpx-engine/execute";
import { createAcpRuntime } from "acpx/runtime";
import { diagnoseAcpSessionError } from "./acp-session-diagnostic.js";
import { normalizeAcpMcpNames } from "./acp-mcp-names.js";
import { reviewMcpEnv, withNativeReviewMcp } from "./review-mcp.js";
import { nativeReviewPermission, NATIVE_REVIEW_TOOL_NAMES } from "./native-review-permission.js";
import { AntigravityConfigSchema, antigravityAdapterConfigSchema, DEFAULT_AGY_SERVER_PATH, normalizeAntigravityPermissionMode } from "./config.js";
import { testEnvironment } from "./test-environment.js";
import { ANTIGRAVITY_MODELS } from "../ui/models.js";
import { fetchDynamicAntigravityModels } from "./discover-models.js";
import { LOCAL_AGENT_TOOL_GUIDANCE, withLocalAgentToolBudget } from "@pilleo/paperclip-adapter-common";

export const type = "antigravity";
export const label = "Google Antigravity (AGY)";
export const models = ANTIGRAVITY_MODELS;

export const antigravityAgentConfigurationDoc = `# Google Antigravity (AGY) Adapter

Runs **Google Antigravity** pair-programming agent sessions via the Agent Client Protocol (ACP) over stdio.

---

## 🚀 Capabilities & Features
- **Pair-Programming Agent Engine:** Native Google DeepMind Antigravity agent integration.
- **Instructions Bundle:** Automatically materializes workspace rules, \`AGENTS.md\`, and custom instructions.
- **Skills Studio:** Mounts custom MCP servers and materialized skills into the AGY subshell.
- **ACP Integration:** Supports bidirectional tool calls, interactive approvals, and real-time streaming logs.
- **Native review permissions:** Read-only reviewer sessions may invoke only the three run-bound native review MCP tools once per call. Repository writes retain the configured ACP policy; explicit deny-all remains deny-all.
- **Token-efficient tools:** Prefer Codanna symbol outlines, git diff hunks, and named tests over dumping whole files.

---

## ⚙️ Configuration Parameters

| Parameter | Description | Default |
|---|---|---|
| **Model** | Select Gemini model (\`gemini-pro-agent\`, \`gemini-3-flash-agent\`, \`gemini-3.5-flash-low\`, etc.) | \`gemini-pro-agent\` |
| **Server Path** | Path to the \`agy\` or \`antigravity\` binary | \`~/.local/bin/agy\` |
| **Permission Mode** | Tool execution policy (\`approve-all\`, \`prompt-on-write\`, \`read-only\`) | \`approve-all\` |
| **ACP launch flags** | The installed AGY ACP CLI is launched without legacy UID/debug flags | none |
`;

function createAntigravityExecutor(nativeReviewBound: boolean,
  onLog?: AdapterExecutionContext["onLog"]): ReturnType<typeof createAcpxEngineExecutor> {
  return createAcpxEngineExecutor({
    adapterType: "antigravity",
    createRuntime: (options) => {
      const runtime = createAcpRuntime({ ...options, ...(nativeReviewBound ? {
        onPermissionRequest: async (request, permissionContext) => {
          if (permissionContext.signal.aborted) return { outcome: "cancel" };
          const hostDecision = await options.onPermissionRequest?.(request, permissionContext);
          if (hostDecision) return hostDecision;
          const decision = nativeReviewPermission(request, options.permissionMode, nativeReviewBound);
          if (NATIVE_REVIEW_TOOL_NAMES.some(name => name === request.raw.toolCall.title)) {
            await onLog?.("stdout", `[ANTIGRAVITY] Native review permission: ${request.raw.toolCall.title}, kind=${request.raw.toolCall.kind ?? "unspecified"}, decision=${decision?.outcome ?? "normal-policy"}.\n`);
          }
          return decision;
        },
      } : {}) });
      const ensureSession = runtime.ensureSession.bind(runtime);
      runtime.ensureSession = async (input) => {
        try {
          return await ensureSession(input);
        } catch (error) {
          const diagnostic = diagnoseAcpSessionError(error);
          if (diagnostic) console.warn(`[ANTIGRAVITY] ACP session/new rejected: ${JSON.stringify(diagnostic)}`);
          throw error;
        }
      };
      return runtime;
    },
  });
}

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
  const permissionMode = normalizeAntigravityPermissionMode(ctx.config?.["permissionMode"]);
  const parsed = AntigravityConfigSchema.safeParse(ctx.config ?? {});
  const config = parsed.success ? parsed.data : AntigravityConfigSchema.parse({});

  const rawServer = config.serverPath || DEFAULT_AGY_SERVER_PATH;
  const serverPath =
    rawServer.includes("/") || rawServer.startsWith(".")
      ? path.resolve(rawServer)
      : rawServer;
  // The interactive `agy` CLI does not speak ACP. The dedicated Zed-distributed
  // server does, but requires --uid= to start its JSON-RPC transport. Never
  // apply the flag to the interactive CLI (it rejects it before initialization).
  if (ctx.config?.["nativeReview"] === true && path.basename(serverPath) !== "agy_acp_server.par") {
    throw new Error("Native Gemini review requires an AGY ACP server, not the interactive agy CLI");
  }
  const quotedServer = /^[a-zA-Z0-9_/.\-]+$/.test(serverPath)
    ? serverPath : `'${serverPath.replaceAll("'", `'"'"'`)}'`;
  const agentCommand = path.basename(serverPath) === "agy_acp_server.par"
    ? `${quotedServer} --uid=` : serverPath;
  const normalizedModel = normalizeAntigravityModel(config.model);
  const rawConfig = (ctx.config ?? {}) as Record<string, unknown>;
  const configuredEnv = rawConfig["env"] && typeof rawConfig["env"] === "object" && !Array.isArray(rawConfig["env"])
    ? rawConfig["env"] as Record<string, unknown> : {};
  const basePath = typeof configuredEnv["PATH"] === "string" ? configuredEnv["PATH"] : process.env["PATH"] ?? "";
  const nodeBin = path.dirname(process.execPath);
  const runtimePath = [nodeBin, ...basePath.split(path.delimiter).filter((entry) => entry && entry !== nodeBin)]
    .join(path.delimiter);

  const acpConfig: Record<string, unknown> = {
    ...ctx.config,
    agent: "antigravity",
    agentCommand,
    env: { ...configuredEnv, PATH: runtimePath },
    permissionMode,
    model: normalizedModel,
    timeoutSec: config.timeoutSec,
  };

  const review = rawConfig["nativeReview"] === true
    ? await withNativeReviewMcp(ctx, String(rawConfig["reviewMcpCommand"] ?? process.execPath), Array.isArray(rawConfig["reviewMcpArgs"]) ? rawConfig["reviewMcpArgs"].map(String) : [fileURLToPath(new URL("../../../orchestrator/dist/server/native-review-mcp-stdio.js", import.meta.url))], reviewMcpEnv(ctx))
    : null;
  const executionCtx = review?.ctx ?? ctx;
  const runtimeMcp = executionCtx.runtimeMcp;
  try {
  return await createAntigravityExecutor(review !== null, ctx.onLog)({
    ...executionCtx,
    ...(runtimeMcp ? { runtimeMcp: { getServers: () => normalizeAcpMcpNames(runtimeMcp.getServers()) } } : {}),
    context: withLocalAgentToolBudget((ctx.context || {}) as Record<string, unknown>),
    config: {
      ...acpConfig,
      promptTemplate:
        typeof acpConfig["promptTemplate"] === "string"
          ? `${LOCAL_AGENT_TOOL_GUIDANCE}\n\n${acpConfig["promptTemplate"]}`
          : acpConfig["promptTemplate"],
    },
  });
  } finally {
    await review?.close();
  }
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
    listModels: async () => await fetchDynamicAntigravityModels(),
    agentConfigurationDoc: antigravityAgentConfigurationDoc,
    getConfigSchema: () => antigravityAdapterConfigSchema,
  };
}

export default createServerAdapter;
