import { describe, expect, it } from "vitest";
import { buildRecoveryCanaryWorkspace } from "../src/core/recovery-canary-workspace.js";
import { resolveProjectMetadata } from "../src/core/parser.js";

describe("pinned-host recovery canary workspace", () => {
  it("registers the real local repository metadata required before native PR review", () => {
    const workspace = buildRecoveryCanaryWorkspace("/tmp/disposable-clean-checkout", "master");
    expect(workspace).toMatchObject({
      sourceType: "local_path",
      cwd: "/tmp/disposable-clean-checkout",
      repoUrl: "https://github.com/pilleo/paperclip-adapters.git",
      defaultRef: "master",
    });
    expect(resolveProjectMetadata({ id: "disposable-project", primaryWorkspace: workspace })).toMatchObject({
      ok: true,
      repoUrl: "https://github.com/pilleo/paperclip-adapters.git",
      defaultRef: "master",
    });
  });
});
