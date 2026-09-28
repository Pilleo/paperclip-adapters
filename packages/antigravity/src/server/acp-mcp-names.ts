import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

/** AGY rejects spaces in MCP server names during session/new. Preserve each server's authority. */
export function normalizeAcpMcpNames(servers: readonly AdapterRuntimeMcpServer[]): AdapterRuntimeMcpServer[] {
  const used = new Set<string>();
  return servers.map((server) => {
    const valid = /^[A-Za-z][A-Za-z0-9_-]*$/.test(server.name);
    const cleaned = valid ? server.name : server.name.toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
    const base = /^[A-Za-z]/.test(cleaned) ? cleaned : `mcp_${cleaned || "server"}`;
    let name = base;
    for (let attempt = 2; used.has(name); attempt++) name = `${base}_${attempt}`;
    used.add(name);
    return { ...server, name };
  });
}
