import { describe, expect, it } from "vitest";
import { assertProjectBackedGitWorkspace } from "../src/core/real-e2e-project-contract.js";

describe("real provider E2E project contract", () => {
  it("accepts only a primary git workspace matching the disposable repository and default branch", () => {
    expect(assertProjectBackedGitWorkspace({
      id: "project-1",
      primaryWorkspace: {
        sourceType: "git_repo",
        repoUrl: "https://github.com/Pilleo/paperclip-adapters-e2e-1.git",
        defaultRef: "master",
      },
      codebase: { effectiveLocalFolder: "/managed/project-1/paperclip-adapters-e2e-1" },
    }, "https://github.com/Pilleo/paperclip-adapters-e2e-1", "master")).toEqual({
      ok: true,
      workspacePath: "/managed/project-1/paperclip-adapters-e2e-1",
    });
  });

  it.each([
    ["local workspace", { sourceType: "local_path", repoUrl: null, defaultRef: null }],
    ["wrong repository", { sourceType: "git_repo", repoUrl: "https://github.com/Pilleo/other", defaultRef: "master" }],
    ["wrong branch", { sourceType: "git_repo", repoUrl: "https://github.com/Pilleo/paperclip-adapters-e2e-1", defaultRef: "main" }],
  ])("rejects %s", (_label, primaryWorkspace) => {
    expect(assertProjectBackedGitWorkspace({
      id: "project-1",
      primaryWorkspace,
      codebase: { effectiveLocalFolder: "/managed/project-1/repo" },
    }, "https://github.com/Pilleo/paperclip-adapters-e2e-1", "master")).toMatchObject({ ok: false });
  });
});
