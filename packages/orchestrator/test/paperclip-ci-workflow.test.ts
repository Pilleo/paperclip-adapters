import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Paperclip CI recovery canary lifecycle", () => {
  it("runs the disposable server canary in every package-runtime lane", async () => {
    const workflow = await readFile(
      resolve(import.meta.dirname, "../../../.github/workflows/paperclip-ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("id: paperclip-server-node");
    expect(workflow).toContain("node-version: 24.x");
    expect(workflow).toContain("nohup setsid paperclipai onboard");
    expect(workflow).toMatch(/paperclipai onboard\s+--run/);
    expect(workflow).toContain("paperclipai onboard --help | grep -F -- '--run' | grep -F 'Start Paperclip immediately'");
    expect(workflow).not.toMatch(/if: matrix\.node-version == '24\.x'/);
    expect(workflow).toContain('PAPERCLIP_E2E_OWNS_SERVER_STATE: "true"');
    expect(workflow).toContain('PAPERCLIP_E2E_DATA_DIR: ${{ runner.temp }}/paperclip-canary-home');
    expect(workflow).toContain('rm -rf -- "$PAPERCLIP_E2E_DATA_DIR"');
    expect(workflow).toContain("run: env -u JULES_API_KEY pnpm test:e2e:jules-recovery");
  });
});
