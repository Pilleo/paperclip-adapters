import { describe, it, expect, vi, beforeEach } from "vitest";
import { isGhCliAuthenticated, getDefaultRepoName, createRemoteGitHubRepo } from "../src/server/git-remote-creator.js";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

describe("git-remote-creator", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("isGhCliAuthenticated returns true when gh auth status succeeds", () => {
    (childProcess.execSync as any).mockReturnValue("");
    expect(isGhCliAuthenticated("/some/dir")).toBe(true);
  });

  it("isGhCliAuthenticated returns false when gh auth status fails", () => {
    (childProcess.execSync as any).mockImplementation(() => {
      throw new Error("not logged in");
    });
    expect(isGhCliAuthenticated("/some/dir")).toBe(false);
  });

  it("getDefaultRepoName returns sanitized base directory name", () => {
    const name = getDefaultRepoName("/home/user/code/my-awesome_project!");
    expect(name).toBe("my-awesome_project-");
  });

  it("createRemoteGitHubRepo executes gh repo create and returns repository", () => {
    (childProcess.execSync as any).mockImplementation((cmd: string) => {
      if (cmd.includes("git config --get remote.origin.url")) {
        return "https://github.com/Pilleo/my-new-repo.git";
      }
      return "";
    });

    const res = createRemoteGitHubRepo({
      cwd: "/home/user/my-new-repo",
      repoName: "my-new-repo",
      isPrivate: true,
    });

    expect(res.success).toBe(true);
    expect(res.repository).toBe("Pilleo/my-new-repo");
    expect(res.hint).toContain("google-jules");
  });

  it("createRemoteGitHubRepo returns structured error on failure", () => {
    (childProcess.execSync as any).mockImplementation(() => {
      throw new Error("gh command failed");
    });

    const res = createRemoteGitHubRepo({
      cwd: "/home/user/my-new-repo",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("Failed to create GitHub repository");
  });
});
