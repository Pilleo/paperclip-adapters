import { describe, expect, it } from "vitest";
import { GIT_COMMAND_TIMEOUT_MS, gitCommandOptions } from "../src/core/git-command-timeout.js";

describe("git command deadline", () => {
  it("kills a stuck Git subprocess after the bounded adapter deadline", () => {
    expect(GIT_COMMAND_TIMEOUT_MS).toBe(30_000);
    expect(gitCommandOptions()).toEqual({ timeout: 30_000, killSignal: "SIGKILL" });
  });
});
