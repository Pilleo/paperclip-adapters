import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { childPlanReviewKey, parseChildPlanReviewDescription, parseQuestionBootstrap } from "@pilleo/paperclip-adapter-common";
import { z } from "zod";

type Card = Record<string, unknown>;
export type NativeReviewScope = { readonly kind: "ordinary" | "status_only"; readonly issueId?: string } |
  { readonly kind: "pending" | "recorded"; readonly cardId: string; readonly cardKind: string; readonly itemId?: string };

function record(value: unknown): Card | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Card : null;
}
function issueId(ctx: AdapterExecutionContext): string {
  const context = ctx.context as Record<string, unknown>;
  const id = context["issueId"] ?? context["taskId"] ?? record(context["paperclipIssue"])?.["id"] ??
    record(record(context["paperclipWake"])?.["issue"])?.["id"] ?? ctx.runtime?.taskKey;
  if (typeof id !== "string" || !id) throw new Error("Native review has no issue scope");
  return id;
}
async function read(ctx: AdapterExecutionContext, path: string): Promise<unknown> {
  const base = (process.env["PAPERCLIP_API_URL"] ?? "http://127.0.0.1:3100").replace(/\/+$/, "").replace(/\/api$/, "");
  const response = await fetch(`${base}/api${path}`, { headers: {
    Authorization: `Bearer ${ctx.authToken}`, "X-Paperclip-Run-Id": ctx.runId,
  }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Native review evidence GET failed (${response.status})`);
  return response.json();
}
async function cards(ctx: AdapterExecutionContext): Promise<Card[]> {
  const raw = await read(ctx, `/issues/${encodeURIComponent(issueId(ctx))}/interactions`);
  if (!Array.isArray(raw) || raw.some(value => record(value) === null)) throw new Error("Native review card list is incomplete");
  return raw as Card[];
}
function owned(card: Card, ctx: AdapterExecutionContext): boolean {
  return card["addresseeAgentId"] === ctx.agent.id && card["companyId"] === ctx.agent.companyId && card["issueId"] === issueId(ctx) &&
    ["request_item_verdicts", "ask_user_questions"].includes(String(card["kind"]));
}
function scope(card: Card, kind: "pending" | "recorded"): Extract<NativeReviewScope, { kind: "pending" | "recorded" }> {
  if (typeof card["id"] !== "string") throw new Error("Native review card identity is missing");
  const payload = record(card["payload"]);
  const items = payload?.["items"];
  const item = Array.isArray(items) && items.length === 1 ? record(items[0]) : null;
  if (card["kind"] === "request_item_verdicts" && typeof item?.["id"] !== "string") throw new Error("Native verdict target is malformed");
  return { kind, cardId: card["id"], cardKind: String(card["kind"]), ...(typeof item?.["id"] === "string" ? { itemId: item["id"] } : {}) };
}
function typedResult(card: Card, expected: Extract<NativeReviewScope, { kind: "pending" | "recorded" }>): boolean {
  const result = record(card["result"]);
  if (expected.cardKind === "ask_user_questions") return result?.["version"] === 1 && result["outcome"] == null &&
    result["cancelled"] !== true && Array.isArray(result["answers"]) && result["answers"].length > 0;
  const items = result?.["items"];
  const item = Array.isArray(items) && items.length === 1 ? record(items[0]) : null;
  return result?.["outcome"] === "resolved" && result["complete"] === true && item !== null && typeof expected.itemId === "string" && item["id"] === expected.itemId &&
    (item["verdict"] === "approve" || item["verdict"] === "reject" && typeof item["reason"] === "string" && item["reason"].trim().length > 0);
}
function helperTargetMatches(description: string, card: Card, ctx: AdapterExecutionContext): boolean {
  const payload = record(card["payload"]), target = record(payload?.["target"]);
  const plan = parseChildPlanReviewDescription(description);
  if (plan) return plan.companyId === ctx.agent.companyId && plan.reviewerAgentId === ctx.agent.id &&
    card["kind"] === "request_item_verdicts" && scope(card, "recorded").itemId === "plan" && card["idempotencyKey"] === childPlanReviewKey(plan) &&
    target?.["type"] === "issue_document" && target["issueId"] === plan.parentIssueId && target["key"] === "plan" &&
    target["documentId"] === plan.documentId && target["revisionId"] === plan.revisionId && target["revisionNumber"] === plan.revisionNumber;
  const question = parseQuestionBootstrap(description);
  if (question) return question.companyId === ctx.agent.companyId && question.reviewerAgentId === ctx.agent.id &&
    card["kind"] === "ask_user_questions" && card["idempotencyKey"] ===
      `jules:question-bootstrap:${question.parentIssueId}:${question.sessionId}:${question.activityId}:${question.generation}`;
  const marker = /^<!-- paperclip-pr-review-child:v([12])\n/.exec(description);
  if (!marker) return false;
  const end = description.indexOf("\n-->", marker[0].length);
  if (end < 0) return false;
  let raw: unknown;
  try { raw = JSON.parse(description.slice(marker[0].length, end)); } catch { return false; }
  const parsed = z.object({ version: z.union([z.literal(1), z.literal(2)]), creatorPrincipal: z.literal("board").optional(),
    companyId: z.string(), parentIssueId: z.string().min(1), reviewerAgentId: z.string(), bootstrapAgentId: z.string().min(1),
    prUrl: z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/), headSha: z.string().regex(/^[a-f0-9]{40}$/i),
    stage: z.enum(["luna", "strong"]) }).safeParse(raw);
  if (!parsed.success) return false;
  const identity = parsed.data;
  const key = typeof card["idempotencyKey"] === "string"
    ? /^pr-review:v\d+:(.*):([a-f0-9]{40}):(luna|terra|strong)(?::contract:[a-z0-9]+)?(?::attempt:[1-9]\d*)?$/i.exec(card["idempotencyKey"]) : null;
  const cardUrl = typeof payload?.["detailsMarkdown"] === "string" ? /^\*\*PR:\*\*\s*(https?:\/\/\S+)/m.exec(payload["detailsMarkdown"])?.[1] : null;
  return identity.version === Number(marker[1]) && (identity.version !== 2 || identity.creatorPrincipal === "board") &&
    identity.companyId === ctx.agent.companyId && identity.reviewerAgentId === ctx.agent.id && identity.bootstrapAgentId !== ctx.agent.id &&
    card["kind"] === "request_item_verdicts" && scope(card, "recorded").itemId === "pull_request" && cardUrl === identity.prUrl &&
    key?.[1] === `${issueId(ctx)}:${identity.prUrl}` && key[2] === identity.headSha &&
    key[3] === identity.stage;
}

/** Read actual addressed cards, never infer a review duty from a wake label. */
export async function readNativeReviewScope(ctx: AdapterExecutionContext): Promise<NativeReviewScope> {
  const run = record(await read(ctx, `/heartbeat-runs/${encodeURIComponent(ctx.runId)}`));
  const snapshot = record(run?.["contextSnapshot"]);
  if (run?.["id"] !== ctx.runId || run["companyId"] !== ctx.agent.companyId || run["agentId"] !== ctx.agent.id ||
      run["status"] !== "running" || snapshot?.["issueId"] !== issueId(ctx)) throw new Error("Native review run lost its exact task authority");
  if (snapshot["recoveryIntent"] === "status_only") {
    if (snapshot["allowDeliverableWork"] !== false || snapshot["allowDocumentUpdates"] !== false || snapshot["resumeRequiresNormalModel"] !== true) {
      throw new Error("Status-only native run has incomplete host mutation guards");
    }
    return { kind: "status_only", issueId: issueId(ctx) };
  }
  if (snapshot["wakeReason"] === "missing_issue_comment") return { kind: "status_only", issueId: issueId(ctx) };
  const own = (await cards(ctx)).filter(card => owned(card, ctx));
  const pending = own.filter(card => card["status"] === "pending");
  if (pending.length > 1) throw new Error("Native review scope has duplicate pending cards");
  if (pending[0]) return scope(pending[0], "pending");
  const answered = own.filter(card => card["status"] === "answered");
  {
    const issue = record(await read(ctx, `/issues/${encodeURIComponent(issueId(ctx))}`));
    const description = issue?.["description"];
    // An ordinary implementation issue may retain historical review cards.
    // Only native helper issues can finish without starting another provider.
    if (issue?.["id"] === issueId(ctx) && issue["companyId"] === ctx.agent.companyId && typeof description === "string" &&
      ["<!-- paperclip-pr-review-child:v", "<!-- paperclip-child-plan-review:v", "<!-- jules-question-bootstrap:v"].some(prefix => description.startsWith(prefix))) {
      const matching = answered.filter(card => helperTargetMatches(description, card, ctx));
      if (matching.length !== 1) throw new Error("Recorded native verdict does not match the exact helper target");
      const card = matching[0]!, recorded = scope(card, "recorded");
      if (!typedResult(card, recorded) || typeof card["resolvedByRunId"] !== "string" ||
          card["resolvedByAgentId"] != null && card["resolvedByAgentId"] !== ctx.agent.id) throw new Error("Recorded native verdict has invalid evidence");
      const resolver = record(await read(ctx, `/heartbeat-runs/${encodeURIComponent(card["resolvedByRunId"])}`));
      if (resolver?.["id"] !== card["resolvedByRunId"] || resolver["companyId"] !== ctx.agent.companyId || resolver["agentId"] !== ctx.agent.id ||
          resolver["status"] !== "succeeded" || record(resolver["contextSnapshot"])?.["issueId"] !== issueId(ctx)) {
        throw new Error("Recorded native verdict resolver is not attributable and settled");
      }
      return recorded;
    }
  }
  return { kind: "ordinary" };
}

/** The API's structured result and physical resolver run are the completion receipt. */
export async function verifyNativeReviewCompletion(ctx: AdapterExecutionContext, expected: Extract<NativeReviewScope, { kind: "pending" | "recorded" }>): Promise<boolean> {
  const card = (await cards(ctx)).find(card => card["id"] === expected.cardId);
  if (!card || !owned(card, ctx) || card["kind"] !== expected.cardKind || card["status"] !== "answered" ||
      card["resolvedByRunId"] !== ctx.runId || (card["resolvedByAgentId"] != null && card["resolvedByAgentId"] !== ctx.agent.id)) return false;
  return typedResult(card, expected);
}
