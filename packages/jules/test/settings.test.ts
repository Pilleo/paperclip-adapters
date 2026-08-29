import { describe, expect, it, vi } from "vitest";
import { redactConfigError, validateConfig } from "../src/server/config.js";

describe("typed Jules settings", () => {
  it("uses safe defaults and derives source from the canonical repository", () => {
    const settings = validateConfig({ repository: "https://github.com/acme/widgets.git", baseBranch: "main" });
    expect(settings).toMatchObject({
      repository: "acme/widgets", source: "sources/github/acme/widgets", baseBranch: "main",
      requirePlanApproval: true, automationMode: "AUTO_CREATE_PR", pollCadenceSeconds: 45,
      requestTimeoutSeconds: 30, retryBudget: 3, sessionDeadlineMinutes: 360, progressVerbosity: "normal",
    });
  });

  it("enforces issue override -> adapter setting -> safe default precedence", () => {
    const settings = validateConfig(
      { repository: "acme/widgets", baseBranch: "develop", retryBudget: 2, progressVerbosity: "quiet" },
      { issueOverride: { baseBranch: "release", retryBudget: 7 } },
    );
    expect(settings).toMatchObject({ baseBranch: "release", retryBudget: 7, progressVerbosity: "quiet", pollCadenceSeconds: 45 });
  });

  it("derives repository and base branch from Paperclip workspace metadata", () => {
    expect(validateConfig({}, { workspace: { repositoryUrl: "git@github.com:acme/widgets.git", defaultBranch: "trunk" } }))
      .toMatchObject({ repository: "acme/widgets", baseBranch: "trunk" });
  });

  it("migrates matching legacy fields with warnings and rejects conflicting intent", () => {
    const warn = vi.fn();
    const migrated = validateConfig({ source: "sources/github/acme/widgets", repository: "acme/widgets", baseBranch: "main" }, { warn });
    expect(migrated.source).toBe("sources/github/acme/widgets");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("`source` is deprecated"));
    expect(() => validateConfig({ source: "sources/github/acme/one", repository: "acme/two", baseBranch: "main" }))
      .toThrow("identify different repositories");
  });

  it("validates bounds and never assumes master", () => {
    expect(() => validateConfig({ repository: "acme/widgets" })).toThrow("could not be derived");
    expect(() => validateConfig({ repository: "acme/widgets", baseBranch: "main", pollCadenceSeconds: 5 })).toThrow("pollCadenceSeconds");
  });

  it("uses no-PR mode without a remote and validates forced PR compatibility", () => {
    const settings = validateConfig({ source: "sources/github/acme/widgets", baseBranch: "main", prPolicy: "auto" }, { workspace: { hasRemote: false } });
    expect(settings.automationMode).toBe("AUTOMATION_MODE_UNSPECIFIED");
    expect(() => validateConfig({ source: "sources/github/acme/widgets", baseBranch: "main", prPolicy: "always" }, { workspace: { hasRemote: false } })).toThrow("requires a remote");
  });

  it("redacts credentials and token-shaped values from startup errors", () => {
    expect(redactConfigError(new Error("bad https://alice:secret@github.com/acme/repo ghp_abcdefghijklmnopqrstuvwxyz")))
      .toBe("bad https://[REDACTED]@github.com/acme/repo [REDACTED]");
  });
});
