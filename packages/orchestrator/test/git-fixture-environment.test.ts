import { describe, expect, it } from "vitest";
import { isolatedGitEnvironment } from "../src/core/git-environment.js";

describe("isolatedGitFixtureEnvironment", () => {
  it("removes inherited Git bindings while preserving ordinary process variables", () => {
    expect(
      isolatedGitEnvironment({
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        GIT_DIR: "/active-repository/.git",
        GIT_WORK_TREE: "/active-repository",
        GIT_INDEX_FILE: "/active-repository/.git/index",
        GIT_CONFIG_GLOBAL: "/active-repository/.gitconfig",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/tmp/home" });
  });
});
