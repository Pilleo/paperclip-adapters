import { describe, expect, it } from "vitest";
import { evaluateWorkspaceSync } from "../src/core/workspace-sync.js";

describe("workspace synchronization policy", () => {
  it.each([
    [
      "holds a dirty checkout without allowing a pull",
      { kind: "dirty", branch: "master", headSha: "a" } as const,
      { repoUrl: "https://github.com/Pilleo/paperclip-adapters.git", defaultRef: "master" } as const,
      "hold" as const,
    ],
    [
      "allows a clean default checkout to fast-forward",
      { kind: "clean_default", branch: "master", headSha: "a", remoteHeadSha: "b" } as const,
      { repoUrl: "https://github.com/Pilleo/paperclip-adapters.git", defaultRef: "master" } as const,
      "fast_forward" as const,
    ],
    [
      "fails closed when project policy is absent",
      { kind: "clean_default", branch: "master", headSha: "a", remoteHeadSha: "b" } as const,
      null,
      "hold" as const,
    ],
  ])("%s", (_name, observation, policy, expectedAction) => {
    expect(evaluateWorkspaceSync({ observation, policy }).action).toBe(expectedAction);
  });
});
