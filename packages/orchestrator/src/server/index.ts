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
  maxConcurrentProjects: z.number().int().min(1).default(2),
  maxConcurrentJules: z.number().int().min(1).default(15),
  maxConcurrentVibe: z.number().int().min(1).default(1),
  julesAgentId: z.string().optional(),
  vibeAgentId: z.string().optional(),
  vibeReviewerAgentId: z.string().optional(),
  reviewerAgentId: z.string().optional(),
  lunaReviewerAgentId: z.string().optional(),
  terraReviewerAgentId: z.string().optional(),
  julesPlanApprovalPolicy: z.enum(["required", "trusted_opt_out"]).default("required"),
  apiUrl: z.string().optional(),
});

export const orchestratorAdapterConfigSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "maxConcurrentProjects",
      label: "Max Concurrent Projects",
      type: "number",
      required: false,
      default: 2,
      hint: "Maximum project state machines running concurrently in one company heartbeat (default: 2)",
    },
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
      hint: "Optional override for the [Orchestrated] Jules worker. Independent Jules agents are never selected.",
    },
    {
      key: "vibeAgentId",
      label: "Vibe Worker Agent ID",
      type: "text",
      required: false,
      hint: "Optional override for the [Orchestrated] Vibe worker. Independent Vibe agents are never selected.",
    },
    {
      key: "lunaReviewerAgentId",
      label: "OpenAI Luna Reviewer Agent ID",
      type: "text",
      required: false,
      hint: "Optional override for the managed read-only OpenAI Luna first reviewer.",
    },
    {
      key: "terraReviewerAgentId",
      label: "OpenAI Terra Reviewer Agent ID",
      type: "text",
      required: false,
      hint: "Optional override for the managed read-only OpenAI Terra strong reviewer.",
    },
    {
      key: "vibeReviewerAgentId",
      label: "Vibe Reviewer Agent ID",
      type: "text",
      required: false,
      hint: "Deprecated compatibility setting; use OpenAI Luna Reviewer Agent ID.",
    },
    {
      key: "reviewerAgentId",
      label: "Reviewer Agent ID",
      type: "text",
      required: false,
      hint: "Deprecated compatibility setting; use OpenAI Terra Reviewer Agent ID.",
    },
    {
      key: "julesPlanApprovalPolicy",
      label: "Jules Plan Approval Policy",
      type: "select",
      required: false,
      default: "required",
      options: [
        { value: "required", label: "Strong review + operator approval" },
        { value: "trusted_opt_out", label: "Strong review + automatic approval" },
      ],
      hint: "The orchestrator selects the managed Jules plan gate. A configured strong reviewer always runs first.",
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
- **Project-Owned Workspaces:** Each company project is processed independently; its configured workspace is the only checkout used for that project's tasks, PRs, locks, and backlog.
- **Fail-Closed Scoping:** Issues without a valid project workspace are skipped and reported instead of falling back to the adapter process directory.
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


export * from "../core/cost-tracker.js";
