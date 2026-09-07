#!/usr/bin/env node
/**
 * Submit a managed native review card without embedding a shell heredoc in the
 * reviewer prompt. The typed implementation owns card discovery and response
 * validation; this file is only the stable runtime entry point.
 */
import { submitNativeReviewVerdict } from "../dist/core/native-review-submission.js";

const verdict = process.env.DECISION;
const stdinReason = verdict === "reject" && !process.env.REASON
  ? (await import("node:fs/promises")).readFile(0, "utf8")
  : "";
const apiBase = process.env.PAPERCLIP_API_URL ?? "";
const issueId = process.env.PAPERCLIP_TASK_ID ?? "";
const agentId = process.env.PAPERCLIP_AGENT_ID ?? "";
const token = process.env.PAPERCLIP_API_KEY ?? "";
let cards = [];
if (apiBase && issueId && agentId && token) {
  const root = apiBase.replace(/\/+$/, "").replace(/\/api$/, "");
  const response = await fetch(`${root}/api/issues/${encodeURIComponent(issueId)}/interactions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    console.error(`[paperclip] Native review card lookup failed: HTTP ${response.status}`);
    process.exitCode = 1;
  } else {
    cards = await response.json();
  }
}

const result = process.exitCode
  ? { ok: false, code: "submit_http_error" }
  : await submitNativeReviewVerdict({
      apiBase,
      issueId,
      agentId,
      token,
      cards,
      verdict,
  reason: (process.env.REASON ?? stdinReason).trim(),
    });

if (!result.ok) {
  console.error(`[paperclip] Native review submission failed: ${result.code}`);
  process.exitCode = 1;
} else {
  console.log(`[paperclip] Native review ${verdict} submitted and verified for card ${result.interactionId}.`);
}
