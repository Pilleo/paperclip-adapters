#!/usr/bin/env node
/**
 * Operator-safe recovery entrypoint for one existing native review card.
 *
 * Keep this command on Paperclip's typed interaction-dispatch path. The
 * generic wake endpoint can start a reviewer heartbeat while dropping the
 * interaction binding; the MCP then correctly fails closed with
 * `missing_runtime_context`. Dispatching the existing card preserves its
 * immutable issue/interaction identity.
 *
 * Required environment: PAPERCLIP_API_URL, PAPERCLIP_AGENT_ID,
 * PAPERCLIP_TASK_ID, PAPERCLIP_WAKE_COMMENT_ID (the native card id).
 * Optional: PAPERCLIP_API_KEY and PAPERCLIP_RUN_ID.
 */
import { createPaperclipHttp } from "../dist/core/paperclip-http.js";
import { recoverNativeReviewCard } from "../dist/core/native-review-recovery.js";
import { provisionNativeReviewMcpHome, resolveNativeReviewMcpHome, resolveNativeReviewRecoveryWorkerKey } from "../dist/core/native-review-mcp-home.js";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const required = ["PAPERCLIP_API_URL", "PAPERCLIP_AGENT_ID", "PAPERCLIP_TASK_ID", "PAPERCLIP_WAKE_COMMENT_ID"];
const missing = required.filter((key) => !(process.env[key] ?? "").trim());
if (missing.length > 0) {
  console.error(`[paperclip] Missing native-review recovery context: ${missing.join(", ")}`);
  process.exit(2);
}

const apiUrl = process.env.PAPERCLIP_API_URL.trim();
const agentId = process.env.PAPERCLIP_AGENT_ID.trim();
const issueId = process.env.PAPERCLIP_TASK_ID.trim();
const interactionId = process.env.PAPERCLIP_WAKE_COMMENT_ID.trim();
const workerKey = resolveNativeReviewRecoveryWorkerKey(process.env.PAPERCLIP_WORKER_KEY);
const paperclip = createPaperclipHttp({
  apiUrl,
  authToken: process.env.PAPERCLIP_API_KEY,
  runId: process.env.PAPERCLIP_RUN_ID,
  localTrustedBoardWrites: true,
});
const instanceRoot = resolvePaperclipInstanceRootForAdapter({
  homeDir: process.env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip"),
  instanceId: process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default",
  env: process.env,
});
const reviewerHome = resolveNativeReviewMcpHome({
  instanceRoot,
  companyId: process.env.PAPERCLIP_COMPANY_ID?.trim() || "",
  workerKey,
});
const authSource = path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "auth.json");
const serverPath = fileURLToPath(new URL("../dist/server/native-review-mcp-stdio.js", import.meta.url));
const result = await recoverNativeReviewCard({
  paperclip,
  agentId,
  issueId,
  interactionId,
  reason: "issue_commented",
  idempotencyKey: `native-review-recovery:v6:${issueId}:${interactionId}`,
  prepareTransport: () => provisionNativeReviewMcpHome({
    home: reviewerHome,
    authSource,
    nodePath: process.execPath,
    serverPath,
    runtimeContext: {
      apiBase: apiUrl,
      companyId: process.env.PAPERCLIP_COMPANY_ID?.trim() || "",
      agentId,
      issueId,
      interactionId,
    },
  }),
});

if (!result.ok) {
  console.error(`[paperclip] Native-review recovery was not sent: HTTP ${result.status}; ${result.code ?? result.text}`);
  process.exit(1);
}
console.log(`[paperclip] Native-review recovery queued: HTTP ${result.status}`);
