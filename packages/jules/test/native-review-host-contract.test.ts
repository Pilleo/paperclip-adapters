import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJulesPlanReviewChildInteraction,
  createJulesPlanReviewInteraction,
} from "../src/server/paperclip-client";

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly sourceRunId: string | null;
  readonly body: Record<string, unknown>;
}

describe.sequential("Legacy native-review provenance transport fixture", () => {
  let server: Server | undefined;
  const originalApiUrl = process.env["PAPERCLIP_API_URL"];

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    }
    server = undefined;
    if (originalApiUrl === undefined) delete process.env["PAPERCLIP_API_URL"];
    else process.env["PAPERCLIP_API_URL"] = originalApiUrl;
  });

  // This models propagation of the legacy provenance error, not host creation
  // authorization. The real v916 contract accepts the POST and then rejects
  // reviewer startup. See orchestrator/test/contract for authenticated proofs.
  it("propagates a simulated cross-issue provenance error and accepts parent-scoped ladder requests", async () => {
    const requests: CapturedRequest[] = [];
    const sourceRunIssueIds = new Map([["parent-jules-run", "parent-issue"]]);
    server = createServer((request, response) => {
      const path = request.url ?? "/";
      const method = request.method ?? "GET";
      const match = /^\/api\/issues\/([^/]+)\/interactions$/.exec(path);
      if (!match) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      if (method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("[]");
        return;
      }

      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const issueId = decodeURIComponent(match[1]!);
        const sourceRunId = typeof request.headers["x-paperclip-run-id"] === "string"
          ? request.headers["x-paperclip-run-id"]
          : null;
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requests.push({ method, path, sourceRunId, body });

        if (!sourceRunId || sourceRunIssueIds.get(sourceRunId) !== issueId) {
          response.writeHead(409, { "content-type": "application/json" });
          response.end(JSON.stringify({
            error: "continuation_source_context_missing",
            message: "The source run must belong to the interaction issue.",
          }));
          return;
        }

        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: `card-${requests.length}`,
          status: "pending",
          kind: body["kind"],
        }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      const rejectListen = (error: Error) => reject(error);
      server!.once("error", rejectListen);
      server!.listen(0, "127.0.0.1", () => {
        server!.off("error", rejectListen);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Host-contract fixture did not bind a TCP port");
    process.env["PAPERCLIP_API_URL"] = `http://127.0.0.1:${address.port}`;

    const revision = { documentId: "plan-doc", revisionId: "plan-revision", revisionNumber: 1 };
    await expect(createJulesPlanReviewChildInteraction(
      "reviewer-child", "parent-issue", "jules-session", revision,
      "# Plan", "luna", "luna-agent", "token", "parent-jules-run", "activity-1",
    )).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("continuation_source_context_missing"),
    });

    await expect(createJulesPlanReviewInteraction(
      "parent-issue", "jules-session", revision,
      "# Plan", "luna", "luna-agent", "token", "parent-jules-run", "activity-1",
    )).resolves.toMatchObject({ status: "pending", kind: "request_item_verdicts" });
    await expect(createJulesPlanReviewInteraction(
      "parent-issue", "jules-session", revision,
      "# Plan", "terra", "terra-agent", "token", "parent-jules-run", "activity-1",
    )).resolves.toMatchObject({ status: "pending", kind: "request_item_verdicts" });

    const writes = requests.filter((captured) => captured.method === "POST");
    expect(writes.map((captured) => captured.path)).toEqual([
      "/api/issues/reviewer-child/interactions",
      "/api/issues/parent-issue/interactions",
      "/api/issues/parent-issue/interactions",
    ]);
    expect(writes.slice(1).map((captured) => captured.body["addresseeAgentId"]))
      .toEqual(["luna-agent", "terra-agent"]);
    expect(requests.some((captured) => captured.path.includes("/comments"))).toBe(false);
  });
});
