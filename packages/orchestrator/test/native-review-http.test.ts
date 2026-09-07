import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeReviewFetch } from "../src/core/native-review-http.js";

describe("native review HTTP transport", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(servers.splice(0).map(async (server) => {
      server.close();
      await once(server, "close");
    }));
  });

  it("uses the sandbox HTTP proxy for the control-plane request", async () => {
    let requestUrl = "";
    const proxy = createServer((request, response) => {
      requestUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    servers.push(proxy);
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("proxy has no address");
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${address.port}`);

    const response = await nativeReviewFetch("http://paperclip.internal/api/agents/me", {
      method: "GET",
      headers: { Authorization: "Bearer run-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(requestUrl).toBe("http://paperclip.internal/api/agents/me");
  });

  it("does not route loopback Paperclip traffic through the inherited proxy", async () => {
    let reachedDirectServer = false;
    const direct = createServer((_request, response) => {
      reachedDirectServer = true;
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"test failure"}');
    });
    const proxy = createServer((_request, response) => {
      response.writeHead(200);
      response.end('{"wrong":"proxy"}');
    });
    servers.push(direct, proxy);
    direct.listen(0, "127.0.0.1");
    proxy.listen(0, "127.0.0.1");
    await Promise.all([once(direct, "listening"), once(proxy, "listening")]);
    const directAddress = direct.address();
    const proxyAddress = proxy.address();
    if (!directAddress || typeof directAddress === "string" || !proxyAddress || typeof proxyAddress === "string") {
      throw new Error("test servers have no TCP address");
    }
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${proxyAddress.port}`);

    const response = await nativeReviewFetch(`http://127.0.0.1:${directAddress.port}/api/issues/issue-1/interactions`);

    expect(response.status).toBe(503);
    expect(reachedDirectServer).toBe(true);
  });
});
