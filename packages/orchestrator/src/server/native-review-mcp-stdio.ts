import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { submitJulesQuestionDecisionFromRuntime, type NativeReviewAssignmentResult, type NativeReviewSubmissionResult } from "../core/native-review-submission.js";
import { readPlanReviewAssignmentAndReconcileHandback, submitPlanVerdictAndReturnToJules } from "../core/native-plan-review-handback.js";
import { NATIVE_REVIEW_RUNTIME_CONTEXT_FILE } from "../core/native-review-mcp-home.js";
import {
  NATIVE_REVIEW_MCP_TOOL,
  JULES_QUESTION_MCP_TOOL,
  NATIVE_REVIEW_ASSIGNMENT_MCP_TOOL,
  createNativeReviewMcpHandler,
  type NativeReviewMcpRequest,
  type NativeReviewMcpResponse,
  type NativeReviewToolArguments,
  type JulesQuestionToolArguments,
} from "./native-review-mcp.js";
import { isFatalNativeReviewMcpError } from "./native-review-mcp.js";
import { NativeReviewArtifactError, readNativePullRequestArtifact } from "../core/native-review-artifact.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

type JsonRpcRequest = {
  readonly jsonrpc?: unknown;
  readonly id?: string | number;
  readonly method?: unknown;
  readonly params?: unknown;
};

type JsonRpcResponse = {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};

export interface NativeReviewMcpRuntime {
  readonly apiBase: string;
  readonly issueId: string;
  readonly agentId: string;
  /** The exact native card bound by Paperclip to this heartbeat run. */
  readonly interactionId?: string;
  readonly token?: string;
  /** Bound run identity authorizes the reviewer to resolve its native card. */
  readonly runId?: string;
}

interface NativeReviewMcpRuntimeIdentity {
  readonly apiBase: string;
  readonly companyId?: string;
  readonly issueId?: string;
  readonly interactionId?: string;
  readonly agentId: string;
  readonly token?: string;
  readonly runId?: string;
}

function readRuntimeContextFile(codexHome: string | undefined): NativeReviewMcpRuntimeIdentity | null {
  if (!codexHome?.trim()) return null;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(codexHome, NATIVE_REVIEW_RUNTIME_CONTEXT_FILE), "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const apiBase = typeof record["apiBase"] === "string" ? record["apiBase"].trim() : "";
    const companyId = typeof record["companyId"] === "string" ? record["companyId"].trim() : "";
    const agentId = typeof record["agentId"] === "string" ? record["agentId"].trim() : "";
    const issueId = typeof record["issueId"] === "string" ? record["issueId"].trim() : "";
    const interactionId = typeof record["interactionId"] === "string" ? record["interactionId"].trim() : "";
    return apiBase && agentId
      ? { apiBase, ...(companyId ? { companyId } : {}), ...(issueId ? { issueId } : {}), ...(interactionId ? { interactionId } : {}), agentId }
      : null;
  } catch {
    return null;
  }
}

export function nativeReviewMcpRuntimeFromEnv(env: NodeJS.ProcessEnv): NativeReviewMcpRuntime | null {
  const identity = nativeReviewMcpRuntimeIdentityFromEnv(env);
  const taskIdFromEnv = env["PAPERCLIP_TASK_ID"]?.trim() ?? "";
  return identity?.issueId && (identity.interactionId || taskIdFromEnv)
    ? {
        apiBase: identity.apiBase,
        issueId: identity.issueId,
        agentId: identity.agentId,
        ...(identity.interactionId ? { interactionId: identity.interactionId } : {}),
        ...(identity.token ? { token: identity.token } : {}),
        ...(identity.runId ? { runId: identity.runId } : {}),
      }
    : null;
}

function nativeReviewMcpRuntimeIdentityFromEnv(env: NodeJS.ProcessEnv): NativeReviewMcpRuntimeIdentity | null {
  const apiBase = env["PAPERCLIP_API_URL"]?.trim() ?? "";
  const companyId = env["PAPERCLIP_COMPANY_ID"]?.trim() ?? "";
  const issueId = env["PAPERCLIP_TASK_ID"]?.trim() ?? "";
  const agentId = env["PAPERCLIP_AGENT_ID"]?.trim() ?? "";
  const token = env["PAPERCLIP_API_KEY"]?.trim() ?? "";
  const runId = env["PAPERCLIP_RUN_ID"]?.trim() ?? "";
  const fileIdentity = readRuntimeContextFile(env["CODEX_HOME"]);
  // Local-trusted Paperclip runs intentionally have no API key. The loopback
  // control plane authenticates the run through its managed execution context;
  // a bearer token is still used automatically when one is supplied.
  const resolvedApiBase = apiBase || fileIdentity?.apiBase || "";
  const resolvedAgentId = agentId || fileIdentity?.agentId || "";
  if (!resolvedApiBase || !resolvedAgentId) return null;
  return {
    apiBase: resolvedApiBase,
    ...(companyId || fileIdentity?.companyId ? { companyId: companyId || fileIdentity?.companyId! } : {}),
    ...(issueId || fileIdentity?.issueId ? { issueId: issueId || fileIdentity?.issueId! } : {}),
    ...(fileIdentity?.interactionId ? { interactionId: fileIdentity.interactionId } : {}),
    agentId: resolvedAgentId,
    ...(token ? { token } : {}),
    ...(runId || fileIdentity?.runId ? { runId: runId || fileIdentity?.runId! } : {}),
  };
}

/**
 * Paperclip may strip task-specific MCP environment variables while retaining
 * the heartbeat run id. The run record is the authoritative, per-invocation
 * binding; resolving through it avoids relying on mutable shared reviewer
 * homes and keeps simultaneous reviewer runs isolated.
 */
async function resolveNativeReviewMcpRuntime(env: NodeJS.ProcessEnv): Promise<NativeReviewMcpRuntime | null> {
  const direct = nativeReviewMcpRuntimeFromEnv(env);
  if (direct) return direct;
  const identity = nativeReviewMcpRuntimeIdentityFromEnv(env);
  if (!identity) return null;
  const base = identity.apiBase.replace(/\/+$/, "").replace(/\/api$/, "");
  try {
    const headers = identity.token ? { headers: { Authorization: `Bearer ${identity.token}` } } : {};
    const runId = identity.runId || await resolveSoleActiveReviewerRunId(base, identity.companyId, identity.agentId, headers);
    if (!runId) return null;
    const response = await fetch(`${base}/api/heartbeat-runs/${encodeURIComponent(runId)}`, headers);
    if (!response.ok) return null;
    const raw: unknown = await response.json();
    const context = raw && typeof raw === "object" && !Array.isArray(raw)
      && (raw as { contextSnapshot?: unknown }).contextSnapshot
      && typeof (raw as { contextSnapshot?: unknown }).contextSnapshot === "object"
      ? (raw as { contextSnapshot: Record<string, unknown> }).contextSnapshot
      : null;
    const issueId = typeof context?.["issueId"] === "string" ? context["issueId"].trim() : "";
    const interactionId = typeof context?.["interactionId"] === "string" ? context["interactionId"].trim() : "";
    // Paperclip v831's native dispatch can wake a foreign reviewer through a
    // durable issue comment while omitting interactionId from the run context.
    // The issue/run pair is still invocation-scoped. Submission below lists
    // cards and accepts exactly one pending card addressed to this agent, so
    // absence of the host binding remains fail-closed for zero or ambiguous
    // cards rather than falling back to mutable reviewer-home state.
    return issueId
      ? {
          apiBase: identity.apiBase,
          issueId,
          agentId: identity.agentId,
          ...(identity.token ? { token: identity.token } : {}),
          // The run endpoint supplies task identity; retain the same run ID
          // for the subsequent list and verdict requests. Without it,
          // Paperclip deliberately rejects the structured card mutation.
          runId,
          ...(interactionId ? { interactionId } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

/** Shared reviewer homes have no task/run state. Pick exactly one live run for
 * this reviewer; any ambiguity is deliberately a failed closed submission. */
async function resolveSoleActiveReviewerRunId(
  base: string,
  companyId: string | undefined,
  agentId: string,
  init: RequestInit,
): Promise<string | null> {
  if (!companyId) return null;
  const response = await fetch(
    `${base}/api/companies/${encodeURIComponent(companyId)}/live-runs?limit=100`,
    init,
  );
  if (!response.ok) return null;
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) return null;
  const candidates = raw.filter((value): value is { id: string; agentId: string; status: string } =>
    typeof value === "object" && value !== null &&
    typeof (value as Record<string, unknown>)["id"] === "string" &&
    typeof (value as Record<string, unknown>)["agentId"] === "string" &&
    (value as Record<string, unknown>)["agentId"] === agentId &&
    ((value as Record<string, unknown>)["status"] === "queued" || (value as Record<string, unknown>)["status"] === "running"),
  );
  return candidates.length === 1 ? candidates[0]!.id : null;
}

function nativeReviewToolDefinition() {
  return {
    name: NATIVE_REVIEW_MCP_TOOL,
    description: "Submit the current agent's structured Paperclip approve or reject verdict.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["verdict"],
      properties: {
        verdict: { type: "string", enum: ["approve", "reject"] },
        reason: { type: "string", description: "Concrete actionable reason; required when rejecting." },
      },
    },
  } as const;
}

function nativeReviewAssignmentToolDefinition() {
  return {
    name: NATIVE_REVIEW_ASSIGNMENT_MCP_TOOL,
    description: "Load the one typed native review assignment addressed to the current reviewer before deciding.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  } as const;
}

function julesQuestionToolDefinition() {
  return {
    name: JULES_QUESTION_MCP_TOOL,
    description: "Submit a typed answer or human escalation for the one Jules question card addressed to this agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "response"],
      properties: {
        decision: { type: "string", enum: ["answer", "escalate"] },
        response: { type: "string" },
      },
    },
  } as const;
}

export function createNativeReviewMcpProtocol(input: {
  readonly submit: (arguments_: NativeReviewToolArguments) => Promise<NativeReviewSubmissionResult>;
  readonly readAssignment?: () => Promise<NativeReviewAssignmentResult>;
  readonly submitJulesQuestion?: (arguments_: JulesQuestionToolArguments) => Promise<
    | { readonly ok: true; readonly interactionId: string; readonly decision: JulesQuestionToolArguments["decision"] }
    | { readonly ok: false; readonly code: string }
  >;
}): (request: JsonRpcRequest) => Promise<JsonRpcResponse | null> {
  const callTool = createNativeReviewMcpHandler({
    submit: input.submit,
    ...(input.readAssignment ? { readAssignment: input.readAssignment } : {}),
    ...(input.submitJulesQuestion ? { submitJulesQuestion: input.submitJulesQuestion } : {}),
  });
  return async (request) => {
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return responseError(request.id, -32600, "Invalid JSON-RPC request.");
    }
    switch (request.method) {
      case "notifications/initialized":
        return null;
      case "initialize":
        return responseResult(request.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "paperclip-native-review", version: "1.0.0" },
        });
      case "tools/list":
        return responseResult(request.id, { tools: [nativeReviewAssignmentToolDefinition(), nativeReviewToolDefinition(), julesQuestionToolDefinition()] });
      case "tools/call": {
        const params = request.params === null || typeof request.params !== "object" || Array.isArray(request.params)
          ? undefined
          : request.params as { readonly name?: unknown; readonly arguments?: unknown };
        const mcpRequest: NativeReviewMcpRequest = params === undefined
          ? { method: "tools/call" }
          : { method: "tools/call", params };
        const result = await callTool(mcpRequest);
        return responseResult(request.id, result satisfies NativeReviewMcpResponse);
      }
      default:
        return responseError(request.id, -32601, "Method not found.");
    }
  };
}

function responseResult(id: unknown, result: unknown): JsonRpcResponse | null {
  return typeof id === "string" || typeof id === "number" ? { jsonrpc: "2.0", id, result } : null;
}

function responseError(id: unknown, code: number, message: string): JsonRpcResponse | null {
  return typeof id === "string" || typeof id === "number" ? { jsonrpc: "2.0", id, error: { code, message } } : null;
}

export async function runNativeReviewMcpStdio(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const protocol = createNativeReviewMcpProtocol({
    // Resolve only when the model invokes the tool. The MCP process can start
    // a few milliseconds before Paperclip records the heartbeat run; resolving
    // once at process startup permanently captures that empty live-run set and
    // turns an otherwise valid review into `missing_runtime_context`.
    submit: async (arguments_) => {
      const runtime = await resolveNativeReviewMcpRuntime(env);
      return runtime === null
        ? { ok: false, code: "missing_runtime_context" as const }
        : submitPlanVerdictAndReturnToJules({ ...runtime, ...arguments_ });
    },
    readAssignment: async () => {
      const runtime = await resolveNativeReviewMcpRuntime(env);
      if (runtime === null) return { ok: false, code: "missing_runtime_context" as const };
      const result = await readPlanReviewAssignmentAndReconcileHandback(runtime);
      if (!result.ok || result.assignment.kind !== "pull_request") return result;
      try {
        const artifact = await readNativePullRequestArtifact(result.assignment, { env });
        return { ok: true, assignment: { ...result.assignment, artifact } };
      } catch (error) {
        return { ok: false, code: error instanceof NativeReviewArtifactError ? error.code : "review_artifact_unavailable" };
      }
    },
    submitJulesQuestion: async (arguments_: JulesQuestionToolArguments) => {
      const runtime = await resolveNativeReviewMcpRuntime(env);
      return runtime === null
        ? { ok: false as const, code: "missing_runtime_context" }
        : submitJulesQuestionDecisionFromRuntime({ ...runtime, ...arguments_ });
    },
  });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      continue;
    }
    const response = await protocol(request);
    if (response) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
      const toolResult = "result" in response ? response.result : undefined;
      if (isFatalNativeReviewMcpError(toolResult)) {
        process.exitCode = 1;
        lines.close();
        break;
      }
    }
  }
}

void runNativeReviewMcpStdio();
