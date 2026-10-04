import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPaperclipJson } from "../src/server/paperclip-client.js";
import { recoverBoardPrChildRejection } from "../src/server/pr-child-feedback.js";

vi.mock("../src/server/paperclip-client.js", () => ({ getPaperclipJson: vi.fn() }));
const identity = { version: 2, creatorPrincipal: "board", companyId: "company", parentIssueId: "parent",
  prUrl: "https://github.com/Pilleo/fixture/pull/21", headSha: "a".repeat(40), stage: "luna",
  reviewerAgentId: "luna", bootstrapAgentId: "orchestrator" };
const child = { id: "helper", companyId: "company", parentId: null, createdByAgentId: null,
  assigneeAgentId: "luna", title: `Review pull request (luna) [pr-review:child:v2:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}]`,
  description: `<!-- paperclip-pr-review-child:v2\n${JSON.stringify(identity)}\n-->\n\nReview the original PR.` };
const input = { companyId: "company", issueId: "parent", prUrl: identity.prUrl, headSha: identity.headSha };

function transport(helper = child, sourceIssueId = "helper") {
  vi.mocked(getPaperclipJson).mockImplementation(async (path: string) => {
    if (path.includes("parentId=")) return Array.from({ length: 25 }, (_, i) => ({ id: `old-${i}`, companyId: "company", parentId: "parent" }));
    if (path.startsWith("/api/companies/company/issues?")) return [helper];
    if (path === "/api/issues/helper/interactions") return [{ id: "card", kind: "request_item_verdicts", status: "answered",
      idempotencyKey: `pr-review:v13:helper:${identity.prUrl}:${identity.headSha}:luna`, addresseeAgentId: "luna",
      sourceRunId: "bootstrap", resolvedByRunId: "reviewer", resolvedByAgentId: "luna",
      result: { outcome: "resolved", complete: true, items: [{ id: "pull_request", verdict: "reject", reason: "Preserve the existing safeInt export." }] } }];
    if (path === "/api/heartbeat-runs/bootstrap") return { id: "bootstrap", companyId: "company", agentId: "orchestrator",
      status: "succeeded", contextSnapshot: { issueId: sourceIssueId } };
    if (path === "/api/heartbeat-runs/reviewer") return { id: "reviewer", companyId: "company", agentId: "luna",
      status: "succeeded", contextSnapshot: { issueId: "helper" } };
    throw new Error(`Unexpected GET ${path}`);
  });
}

afterEach(() => vi.resetAllMocks());
describe("standalone native PR rejection feedback", () => {
  it("recovers the exact typed rejection after helper quota exhaustion", async () => {
    transport();
    expect(await recoverBoardPrChildRejection(input)).toMatchObject({ kind: "code_review_rejection",
      reviewInteractionId: "card", prUrl: identity.prUrl, headSha: identity.headSha,
      reason: "Preserve the existing safeInt export." });
  });
  it("does not promote an uncorrelated standalone task into worker feedback", async () => {
    transport({ ...child, title: "ordinary task" });
    expect(await recoverBoardPrChildRejection(input)).toBeNull();
  });
  it("requires the standalone card's actual child-scoped source run", async () => {
    transport(child, "parent");
    await expect(recoverBoardPrChildRejection(input)).rejects.toThrow("provenance");
  });
});
