import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Paperclip CI recovery canary lifecycle", () => {
  it("runs onboarding as the single backgrounded server process", async () => {
    const workflow = await readFile(
      resolve(import.meta.dirname, "../../../.github/workflows/paperclip-ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("nohup setsid paperclipai onboard");
    expect(workflow).not.toContain("paperclipai run --config");
  });
});
