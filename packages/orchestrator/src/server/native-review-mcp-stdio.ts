import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { submitNativeReviewVerdictFromRuntime, type NativeReviewSubmissionResult } from "../core/native-review-submission.js";
import { NATIVE_REVIEW_RUNTIME_CONTEXT_FILE } from "../core/native-review-mcp-home.js";
import {
  NATIVE_REVIEW_MCP_TOOL,
  createNativeReviewMcpHandler,
  type NativeReviewMcpRequest,
  type NativeReviewMcpResponse,
  type NativeReviewToolArguments,
} from "./native-review-mcp.js";
import { isFatalNativeReviewMcpError } from "./native-review-mcp.js";

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
  readonly token?: string;
}

function readRuntimeContextFile(codexHome: string | undefined): NativeReviewMcpRuntime | null {
  if (!codexHome?.trim()) return null;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(codexHome, NATIVE_REVIEW_RUNTIME_CONTEXT_FILE), "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const apiBase = typeof record["apiBase"] === "string" ? record["apiBase"].trim() : "";
    const issueId = typeof record["issueId"] === "string" ? record["issueId"].trim() : "";
    const agentId = typeof record["agentId"] === "string" ? record["agentId"].trim() : "";
    const runId = typeof record["runId"] === "string" ? record["runId"].trim() : "";
    return apiBase && issueId && agentId
      ? { apiBase, issueId, agentId, ...(runId ? { runId } : {}) }
      : null;
  } catch {
    return null;
  }
}

export function nativeReviewMcpRuntimeFromEnv(env: NodeJS.ProcessEnv): NativeReviewMcpRuntime | null {
  const apiBase = env["PAPERCLIP_API_URL"]?.trim() ?? "";
  const issueId = env["PAPERCLIP_TASK_ID"]?.trim() ?? "";
  const agentId = env["PAPERCLIP_AGENT_ID"]?.trim() ?? "";
  const token = env["PAPERCLIP_API_KEY"]?.trim() ?? "";
  // Local-trusted Paperclip runs intentionally have no API key. The loopback
  // control plane authenticates the run through its managed execution context;
  // a bearer token is still used automatically when one is supplied.
  if (apiBase && issueId && agentId) return { apiBase, issueId, agentId, ...(token ? { token } : {}) };
  return readRuntimeContextFile(env["CODEX_HOME"]);
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

export function createNativeReviewMcpProtocol(input: {
  readonly submit: (arguments_: NativeReviewToolArguments) => Promise<NativeReviewSubmissionResult>;
}): (request: JsonRpcRequest) => Promise<JsonRpcResponse | null> {
  const callTool = createNativeReviewMcpHandler({ submit: input.submit });
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
        return responseResult(request.id, { tools: [nativeReviewToolDefinition()] });
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
  const runtime = nativeReviewMcpRuntimeFromEnv(env);
  const protocol = createNativeReviewMcpProtocol({
    submit: async (arguments_) => runtime === null
      ? { ok: false, code: "missing_runtime_context" }
      : submitNativeReviewVerdictFromRuntime({ ...runtime, ...arguments_ }),
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
