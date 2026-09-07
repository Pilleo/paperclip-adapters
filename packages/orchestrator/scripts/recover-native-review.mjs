#!/usr/bin/env node
/**
 * Operator-safe recovery entrypoint for one existing native review card.
 *
 * Keep this command on the typed adapter path: Paperclip reads issue identity
 * from the nested wake payload. A hand-written top-level issueId silently
 * creates an unscoped run and can fall back to the agent home, where Codex
 * correctly rejects the repository as untrusted.
 *
 * Required environment: PAPERCLIP_API_URL, PAPERCLIP_AGENT_ID,
 * PAPERCLIP_TASK_ID, PAPERCLIP_WAKE_COMMENT_ID (the native card id).
 * Optional: PAPERCLIP_API_KEY and PAPERCLIP_RUN_ID.
 */
import { createPaperclipHttp } from "../dist/core/paperclip-http.js";
import { prepareAndWakeNativeReview } from "../dist/core/native-review-recovery.js";

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
const paperclip = createPaperclipHttp({
  apiUrl,
  authToken: process.env.PAPERCLIP_API_KEY,
  runId: process.env.PAPERCLIP_RUN_ID,
  localTrustedBoardWrites: true,
});
const result = await prepareAndWakeNativeReview({
  paperclip,
  agentId,
  issueId,
  interactionId,
  reason: `Recover native review card ${interactionId} for issue ${issueId}`,
  idempotencyKey: `native-review-recovery:v2:${issueId}:${interactionId}`,
});

if (!result.ok) {
  console.error(`[paperclip] Native-review recovery was not sent: ${result.code}`);
  process.exit(1);
}
console.log(`[paperclip] Native-review recovery queued: HTTP ${result.status}`);
