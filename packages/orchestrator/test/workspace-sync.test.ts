import { describe, expect, it } from "vitest";
import { evaluateWorkspaceSync, isFreshDispatchAllowed, observeWorkspaceSync, reconcileWorkspaceSync, synchronizeWorkspace } from "../src/core/workspace-sync.js";

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
        if (command.startsWith("fetch --no-tags https://github.com/Pilleo/paperclip-adapters.git master:refs/paperclip-sync/master-")) return "";
        if (command.startsWith("rev-parse refs/paperclip-sync/master-")) return "remote\n";
        if (command.startsWith("update-ref -d refs/paperclip-sync/master-")) return "";
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

  it.each([
    ["couldn't find remote ref master", "default_ref_missing"],
    ["fatal: repository unavailable", "remote_unavailable"],
    ["Could not resolve host: github.example", "remote_unavailable"],
  ] as const)("classifies configured-remote fetch failure %s as %s", async (failure, expectedKind) => {
    const observation = await observeWorkspaceSync({
      workspacePath: "/workspace",
      policy: { repoUrl: "https://github.example/acme/repo.git", defaultRef: "master" },
      runGit: async (args) => {
        const command = args.join(" ");
        if (command === "status --porcelain") return "";
        if (command === "branch --show-current") return "master";
        if (command === "rev-parse HEAD") return "local";
        if (command.startsWith("fetch --no-tags https://github.example/acme/repo.git master:refs/paperclip-sync/")) {
          throw new Error(failure);
        }
        if (command.startsWith("update-ref -d refs/paperclip-sync/")) return "";
        throw new Error(`unexpected git command: ${command}`);
      },
    });

    expect(observation).toMatchObject({ kind: expectedKind, detail: expect.stringContaining(failure) });
  });

  it("uses distinct disposable refs for concurrent observations", async () => {
    const commands: string[] = [];
    const runGit = async (args: readonly string[]) => {
      const command = args.join(" ");
      commands.push(command);
      if (command === "status --porcelain") return "";
      if (command === "branch --show-current") return "master";
      if (command === "rev-parse HEAD") return "local";
      if (command.startsWith("fetch --no-tags ")) return "";
      if (command.startsWith("rev-parse refs/paperclip-sync/")) return "local";
      if (command.startsWith("update-ref -d refs/paperclip-sync/")) return "";
      throw new Error(`unexpected git command: ${command}`);
    };

    await Promise.all([
      observeWorkspaceSync({ workspacePath: "/workspace", policy: { repoUrl: "https://github.example/acme/repo.git", defaultRef: "master" }, runGit }),
      observeWorkspaceSync({ workspacePath: "/workspace", policy: { repoUrl: "https://github.example/acme/repo.git", defaultRef: "master" }, runGit }),
    ]);

    const refs = commands
      .filter((command) => command.startsWith("fetch --no-tags "))
      .map((command) => command.match(/:(refs\/paperclip-sync\/[^ ]+)$/)?.[1]);
    expect(new Set(refs).size).toBe(2);
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

  it("turns a failed ff-only pull into a typed hold", async () => {
    const decision = await reconcileWorkspaceSync({
      workspacePath: "/workspace",
      policy: { repoUrl: "https://github.example/acme/repo.git", defaultRef: "master" },
      runGit: async (args) => {
        const command = args.join(" ");
        if (command === "status --porcelain") return "";
        if (command === "branch --show-current") return "master";
        if (command === "rev-parse HEAD") return "local";
        if (command.startsWith("fetch --no-tags ")) return "";
        if (command.startsWith("rev-parse refs/paperclip-sync/")) return "remote";
        if (command.startsWith("update-ref -d refs/paperclip-sync/")) return "";
        if (command === "merge-base --is-ancestor local remote") return "";
        if (command === "pull --ff-only https://github.example/acme/repo.git master") throw new Error("network dropped during pull");
        throw new Error(`unexpected git command: ${command}`);
      },
    });

    expect(decision).toEqual({ action: "hold", reason: "Fast-forward pull failed: Error: network dropped during pull" });
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

  it.each([
    [{ action: "ready" } as const, true],
    [{ action: "fast_forward", repoUrl: "https://github.example/acme/repo.git", defaultRef: "master" } as const, false],
    [{ action: "hold", reason: "dirty" } as const, false],
  ])("admits fresh dispatch only for %o", (decision, expected) => {
    expect(isFreshDispatchAllowed(decision)).toBe(expected);
  });
});
