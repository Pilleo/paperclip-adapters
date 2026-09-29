import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { reportJulesStatusOnlyRun } from "../src/server/paperclip-client.js";

const previousApi = process.env.PAPERCLIP_API_URL;
afterEach(() => {
  if (previousApi === undefined) delete process.env.PAPERCLIP_API_URL;
  else process.env.PAPERCLIP_API_URL = previousApi;
});

it("reports one exact-run status without a provider call, deliverable mutation or native verdict", async () => {
  const requests: Array<{ method?: string; url?: string; runId?: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, runId: req.headers["x-paperclip-run-id"] as string,
      body: JSON.parse(body) as unknown });
    res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: "comment-1" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback port");
    process.env.PAPERCLIP_API_URL = `http://127.0.0.1:${address.port}`;
    await reportJulesStatusOnlyRun("issue-1", "fixture-token", "run-1");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", url: "/api/issues/issue-1/comments", runId: "run-1" });
    expect(requests[0]?.body).toEqual({ body: expect.stringContaining("status-only") });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(resolve));
  }
});
