import { describe, expect, it } from "vitest";
import { normalizeAcpMcpNames } from "../src/server/acp-mcp-names.js";

describe("AGY ACP MCP server names", () => {
  it("normalizes host names rejected by session/new without changing connection authority", () => {
    const original = { name: "Paperclip projects", url: "http://127.0.0.1:3100/mcp",
      token: "private-token", connectionId: "project-tools" };
    const [normalized] = normalizeAcpMcpNames([original]);
    expect(normalized).toEqual({ ...original, name: "paperclip_projects" });
    expect(original.name).toBe("Paperclip projects");
  });

  it("keeps valid review names and distinguishes two host names with the same normalized name", () => {
    const servers = [
      { name: "paperclip_review", url: "http://localhost/a", token: "a", connectionId: "review" },
      { name: "Paperclip projects", url: "http://localhost/b", token: "b", connectionId: "projects" },
      { name: "paperclip_projects", url: "http://localhost/c", token: "c", connectionId: "other-projects" },
    ];
    const first = normalizeAcpMcpNames(servers);
    const second = normalizeAcpMcpNames(servers);
    expect(first.map((server) => server.name)).toEqual(["paperclip_review", "paperclip_projects", "paperclip_projects_2"]);
    expect(second).toEqual(first);
    expect(first.map((server) => server.token)).toEqual(["a", "b", "c"]);
  });
});
