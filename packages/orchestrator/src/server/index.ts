import { z } from "zod";
import type {
  ServerAdapterModule,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterConfigSchema,
} from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

export { execute };

export const OrchestratorConfigSchema = z.object({
  maxConcurrentJules: z.number().int().min(1).default(15),
  maxConcurrentVibe: z.number().int().min(1).default(1),
  julesAgentId: z.string().optional(),
  vibeAgentId: z.string().optional(),
  reviewerAgentId: z.string().optional(),
  workspacePath: z.string().optional(),
  apiUrl: z.string().optional(),
});

export const orchestratorAdapterConfigSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "maxConcurrentJules",
      label: "Max Concurrent Jules Sessions",
      type: "number",
      required: false,
      default: 15,
      hint: "Maximum simultaneous asynchronous Jules development sessions (default: 15)",
    },
    {
      key: "maxConcurrentVibe",
      label: "Max Concurrent Vibe Tasks",
      type: "number",
      required: false,
      default: 1,
      hint: "Maximum simultaneous local Vibe development/clarification tasks (default: 1)",
    },
    {
      key: "julesAgentId",
      label: "Jules Worker Agent ID",
      type: "text",
      required: false,
      hint: "Auto-detects Async software developer if left blank",
    },
    {
      key: "vibeAgentId",
      label: "Vibe Worker Agent ID",
      type: "text",
      required: false,
      hint: "Auto-detects Vibe ACP Developer if left blank",
    },
    {
      key: "reviewerAgentId",
      label: "Reviewer Agent ID",
      type: "text",
      required: false,
      hint: "Auto-detects Security/Reviewer agent if left blank",
    },
    {
      key: "workspacePath",
      label: "Workspace Path",
      type: "text",
      required: false,
      default: "/home/leanid/Documents/code/java/jseccomp",
      hint: "Absolute path to repository workspace",
    },
  ],
};

export const orchestratorAgentConfigurationDoc = `# Deterministic Task Orchestrator Adapter

Executes an in-process, deterministic scheduling control plane on each heartbeat tick at **$0.00 token cost**.

---

## 🚀 Capabilities & Features
- **Multi-Lane Dispatcher:** Routes tasks across **Jules** (up to 15 concurrent remote sessions) and **Vibe** (local kernel/enforcer tasks).
- **Two-Way Backlog Ingestion:** Scans \`docs/internals/backlog/*.md\`, registers board tasks, and synchronizes YAML frontmatter.
- **Automated Archival:** Automatically moves completed/merged tasks to \`docs/internals/backlog/resolved/\` and updates the index.
- **Vibe-Backed Clarification:** Automatically routes tasks with \`open_questions: true\` to Vibe to conduct task interviews before Jules begins execution.
- **DAG Conflict Matrix:** Prevents race conditions by locking active in-flight files and enforcing explicit issue dependencies.
- **Live Jules Quota:** Real-time quota integration against Google Jules API rate limits (15 concurrent, 100/day).
`;

export async function testEnvironment(
  _ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return {
    adapterType: "orchestrator",
    status: "pass",
    testedAt: new Date().toISOString(),
    checks: [
      {
        code: "in_process_runtime_ok",
        level: "info",
        message: "Deterministic Orchestrator in-process runtime is ready",
        detail: null,
        hint: null,
      },
    ],
  };
}

export function createServerAdapter(): ServerAdapterModule {
  return {
    type: "orchestrator",
    execute,
    testEnvironment,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    models: [],
    modelProfiles: [],
    listModels: async () => [],
    listModelProfiles: async () => [],
    agentConfigurationDoc: orchestratorAgentConfigurationDoc,
    getConfigSchema: () => orchestratorAdapterConfigSchema,
  };
}

export default createServerAdapter;

export * from "../core/qa-firewall.js";

export * from "../core/strong-model-reviewer.js";
