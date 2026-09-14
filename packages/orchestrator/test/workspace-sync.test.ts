import { describe, expect, it } from "vitest";
import { evaluateWorkspaceSync, observeWorkspaceSync, synchronizeWorkspace } from "../src/core/workspace-sync.js";

describe("workspace synchronization policy", () => {
  it("classifies a clean default checkout that is ahead as a hold", async () => {
    const observation = await observeWorkspaceSync({
      workspacePath: "/workspace",
      policy: { repoUrl: "https://github.com/Pilleo/paperclip-adapters.git", defaultRef: "master" },
      runGit: async (args) => {
        const command = args.join(" ");
        if (command === "status --porcelain") return "";
        if (command === "branch --show-current") return "master\n";
        if (command === "rev-parse HEAD") return "local\n";
        if (command.startsWith("fetch --no-tags https://github.com/Pilleo/paperclip-adapters.git master:refs/paperclip-sync/master")) return "";
        if (command === "rev-parse refs/paperclip-sync/master") return "remote\n";
        if (command === "update-ref -d refs/paperclip-sync/master") return "";
        if (command === "merge-base --is-ancestor local remote") throw new Error("not an ancestor");
        if (command === "merge-base --is-ancestor remote local") return "";
        throw new Error(`unexpected git command: ${command}`);
      },
    });

    expect(observation).toMatchObject({ kind: "local_ahead", headSha: "local", remoteHeadSha: "remote" });
  });

  it("holds when the configured default ref is absent", () => {
    expect(evaluateWorkspaceSync({
      policy: { repoUrl: "https://github.com/Pilleo/paperclip-adapters.git", defaultRef: "master" },
      observation: { kind: "default_ref_missing", detail: "refs/heads/master" },
    }).action).toBe("hold");
  });

  it("uses an ff-only pull only for a proven-behind checkout", async () => {
    const commands: string[] = [];
    await synchronizeWorkspace({
      workspacePath: "/workspace",
      policy: { repoUrl: "https://github.com/Pilleo/paperclip-adapters.git", defaultRef: "master" },
      observation: { kind: "clean_behind", branch: "master", headSha: "a", remoteHeadSha: "b" },
      runGit: async (args) => {
        commands.push(args.join(" "));
        return "";
      },
    });

    expect(commands).toEqual(["pull --ff-only https://github.com/Pilleo/paperclip-adapters.git master"]);
  });

  it.each([
    [
      "holds a dirty checkout without allowing a pull",
      { kind: "dirty", branch: "master", headSha: "a" } as const,
      { repoUrl: "https://github.com/Pilleo/paperclip-adapters.git", defaultRef: "master" } as const,
      "hold" as const,
    ],
    [
      "allows only a checkout proven behind the configured remote to fast-forward",
      { kind: "clean_behind", branch: "master", headSha: "a", remoteHeadSha: "b" } as const,
      { repoUrl: "https://github.com/Pilleo/paperclip-adapters.git", defaultRef: "master" } as const,
      "fast_forward" as const,
    ],
    [
      "allows an already synchronized checkout without a Git mutation",
      { kind: "clean_synced", branch: "master", headSha: "a", remoteHeadSha: "a" } as const,
      { repoUrl: "https://github.com/Pilleo/paperclip-adapters.git", defaultRef: "master" } as const,
      "ready" as const,
    ],
    [
      "holds a clean checkout that is ahead of the configured remote",
      { kind: "local_ahead", branch: "master", headSha: "b", remoteHeadSha: "a" } as const,
      { repoUrl: "https://github.com/Pilleo/paperclip-adapters.git", defaultRef: "master" } as const,
      "hold" as const,
    ],
    [
      "fails closed when project policy is absent",
      { kind: "clean_behind", branch: "master", headSha: "a", remoteHeadSha: "b" } as const,
      null,
      "hold" as const,
    ],
  ])("%s", (_name, observation, policy, expectedAction) => {
    expect(evaluateWorkspaceSync({ observation, policy }).action).toBe(expectedAction);
  });
});
