import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Paperclip CI recovery canary lifecycle", () => {
  it("runs the disposable server canary in every package-runtime lane", async () => {
    const workflow = await readFile(
      resolve(import.meta.dirname, "../../../.github/workflows/paperclip-ci.yml"),
      "utf8",
    );

    // The package build/test matrix is the adapter compatibility contract.
    // The current control plane itself requires Node 24, so a Node-22 matrix
    // job provisions that runtime only after it has executed package checks.
    expect(workflow).toContain("id: paperclip-server-node");
    expect(workflow).toContain("node-version: 24.x");
    expect(workflow).toContain("nohup setsid paperclipai onboard");
    expect(workflow).toMatch(/paperclipai onboard\s+--run/);
    expect(workflow).not.toMatch(/if: matrix\.node-version == '24\.x'/);
    expect(workflow).toContain("run: env -u JULES_API_KEY pnpm test:e2e:jules-recovery");
  });
});
