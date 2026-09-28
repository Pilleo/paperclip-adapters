import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveGeminiAcpServerPath } from "../src/core/gemini-acp-server.js";

describe("managed Gemini ACP server selection", () => {
  it("discovers the one executable dedicated ACP server without using interactive agy", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "gemini-acp-discovery-"));
    try {
      const server = path.join(home, ".local/share/zed/external_agents/registry/antigravity-acp/v_1/agy_acp_server.par");
      await mkdir(path.dirname(server), { recursive: true });
      await writeFile(server, "#!/bin/sh\n");
      await chmod(server, 0o700);
      expect(resolveGeminiAcpServerPath({ homeDir: home, env: {} })).toBe(server);
      expect(resolveGeminiAcpServerPath({ homeDir: home, env: { ANTIGRAVITY_ACP_SERVER: server } })).toBe(server);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it("refuses multiple installations or an interactive CLI path", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "gemini-acp-ambiguous-"));
    try {
      for (const version of ["v_1", "v_2"]) {
        const server = path.join(home, `.local/share/zed/external_agents/registry/antigravity-acp/${version}/agy_acp_server.par`);
        await mkdir(path.dirname(server), { recursive: true });
        await writeFile(server, "#!/bin/sh\n");
        await chmod(server, 0o700);
      }
      expect(() => resolveGeminiAcpServerPath({ homeDir: home, env: {} })).toThrow(/ambiguous/i);
      expect(() => resolveGeminiAcpServerPath({ homeDir: home, env: { ANTIGRAVITY_ACP_SERVER: "/usr/bin/agy" } })).toThrow(/ACP server/i);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
