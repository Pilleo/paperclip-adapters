import http from "node:http";

/**
 * Fetch implementation for the reviewer MCP child.
 *
 * Paperclip's allowlisted Bubblewrap network is intentionally proxy-only. Node's
 * built-in fetch does not consume HTTP_PROXY, so using it directly makes the
 * MCP child disappear with a misleading "Transport closed" error. This small
 * adapter speaks the proxy's absolute-form HTTP request contract and keeps the
 * model-facing surface limited to the typed review tool.
 */
export async function nativeReviewFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const target = new URL(String(url));
  // Paperclip's local control plane is deliberately reachable directly from
  // the MCP child. Inheriting a host HTTP_PROXY here sends localhost traffic
  // to an unrelated proxy and turns a deterministic card response into a
  // misleading MCP transport timeout.
  if (isLoopbackHost(target.hostname)) return globalThis.fetch(target, init);
  const proxyValue = process.env["HTTP_PROXY"]?.trim() || process.env["http_proxy"]?.trim();
  if (!proxyValue) return globalThis.fetch(url, init);

  const proxy = new URL(proxyValue);
  if (proxy.protocol !== "http:" || target.protocol !== "http:") return globalThis.fetch(url, init);

  const headers = new Headers(init.headers);
  const body = typeof init.body === "string" ? init.body : init.body == null ? undefined : String(init.body);
  if (body !== undefined && !headers.has("content-length")) headers.set("content-length", String(Buffer.byteLength(body)));

  return new Promise<Response>((resolve, reject) => {
    const request = http.request({
      hostname: proxy.hostname,
      port: proxy.port || 80,
      method: init.method ?? "GET",
      path: target.toString(),
      headers: Object.fromEntries(headers.entries()),
      ...(proxy.username || proxy.password
        ? { auth: `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}` }
        : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string") responseHeaders.set(key, value);
          else if (Array.isArray(value)) responseHeaders.set(key, value.join(", "));
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 502,
          ...(response.statusMessage ? { statusText: response.statusMessage } : {}),
          headers: responseHeaders,
        }));
      });
      response.on("error", reject);
    });
    request.setTimeout(15_000, () => request.destroy(new Error("native review proxy request timed out")));
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
