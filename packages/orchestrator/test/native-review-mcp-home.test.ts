import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeReviewMcpConfigToml,
  nativeReviewRuntimeContextPath,
  provisionNativeReviewMcpHome,
  resolveNativeReviewRecoveryWorkerKey,
  resolveNativeReviewMcpHome,
} from "../src/core/native-review-mcp-home.js";

describe("managed native reviewer MCP home", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
  });
  it("uses a dedicated per-company/per-role home instead of the user's CODEX_HOME", () => {
    expect(resolveNativeReviewMcpHome({
      instanceRoot: "/state/paperclip/default",
      companyId: "company-1",
      workerKey: "luna_reviewer",
    })).toBe("/state/paperclip/default/companies/company-1/native-review-mcp/luna_reviewer");
  });

  it("selects the explicit reviewer role for an operator recovery wake", () => {
    expect(resolveNativeReviewRecoveryWorkerKey("terra_reviewer")).toBe("terra_reviewer");
    expect(resolveNativeReviewRecoveryWorkerKey()).toBe("luna_reviewer");
    expect(() => resolveNativeReviewRecoveryWorkerKey("unknown_reviewer")).toThrow("PAPERCLIP_WORKER_KEY");
  });

  it("generates one stdio tool with static company identity and no credential material", () => {
    const config = nativeReviewMcpConfigToml({
      nodePath: "/usr/bin/node",
      serverPath: "/adapter/dist/server/native-review-mcp-stdio.js",
      runtimeContext: {
        apiBase: "http://127.0.0.1:3100",
        companyId: "company-1",
        agentId: "agent-1",
        issueId: "issue-1",
        interactionId: "card-1",
      },
    });
    expect(config).toContain('[mcp_servers.paperclip_review]');
    expect(config).toContain('[shell_environment_policy]');
    expect(config).toContain('inherit = "all"');
    expect(config).toContain('command = "/usr/bin/node"');
    expect(config).toContain('"/adapter/dist/server/native-review-mcp-stdio.js"');
    expect(config).toContain('[mcp_servers.paperclip_review.env]');
    expect(config).toContain('PAPERCLIP_API_URL = "http://127.0.0.1:3100"');
    expect(config).toContain('PAPERCLIP_COMPANY_ID = "company-1"');
    expect(config).toContain('PAPERCLIP_AGENT_ID = "agent-1"');
    expect(config).not.toContain("PAPERCLIP_TASK_ID");
    expect(config).not.toContain("PAPERCLIP_RUN_ID");
    expect(config).not.toContain("PAPERCLIP_API_KEY");
    expect(config).not.toContain("Authorization");
  });

  it("provisions restrictive config and an auth symlink without copying the credential", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-review-home-"));
    cleanup.push(root);
    const authSource = path.join(root, "shared", "auth.json");
    await fs.mkdir(path.dirname(authSource), { recursive: true });
    await fs.writeFile(authSource, '{"tokens":"not-a-real-secret"}', { mode: 0o600 });
    const home = path.join(root, "reviewer");

    await provisionNativeReviewMcpHome({
      home,
      authSource,
      nodePath: "/usr/bin/node",
      serverPath: "/adapter/dist/server/native-review-mcp-stdio.js",
      runtimeContext: {
        apiBase: "http://127.0.0.1:3100",
        companyId: "company-1",
        agentId: "agent-1",
        issueId: "issue-1",
        interactionId: "card-1",
      },
    });

    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toContain("paperclip_review");
    expect(JSON.parse(await fs.readFile(nativeReviewRuntimeContextPath(home), "utf8"))).toEqual({
      apiBase: "http://127.0.0.1:3100", companyId: "company-1", agentId: "agent-1", issueId: "issue-1", interactionId: "card-1",
    });
    expect((await fs.stat(nativeReviewRuntimeContextPath(home))).mode & 0o777).toBe(0o600);
    expect(await fs.readlink(path.join(home, "auth.json"))).toBe(authSource);
    expect((await fs.stat(path.join(home, "config.toml"))).mode & 0o777).toBe(0o600);
  });
});
