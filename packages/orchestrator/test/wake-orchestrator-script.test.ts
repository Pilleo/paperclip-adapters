import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../../../scripts/fleet/wake_orchestrator.sh");

function runWake(projectId?: string) {
  const fixture = mkdtempSync(path.join(tmpdir(), "wake-orchestrator-"));
  const curlLog = path.join(fixture, "curl-args.txt");
  const curl = path.join(fixture, "curl");
  writeFileSync(curl, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${curlLog}"\nprintf '{"id":"run-1","status":"queued"}'\n`);
  chmodSync(curl, 0o755);
  const result = spawnSync("bash", [script, ...(projectId ? [projectId] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture}:${process.env["PATH"] ?? ""}`,
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
    },
  });
  return {
    ...result,
    curlArgs: result.status === 0 ? readFileSync(curlLog, "utf8") : "",
  };
}

describe("wake_orchestrator.sh", () => {
  it("encodes an explicit project as the authoritative wake scope", () => {
    const result = runWake("project-123");

    expect(result.status).toBe(0);
    expect(result.curlArgs).toContain(
      '{"reason": "paperclip-orchestrator-scope/v1/project/project-123"}',
    );
  });

  it("fails before calling Paperclip when no project scope is supplied", () => {
    const result = runWake();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("project ID is required");
    expect(result.curlArgs).toBe("");
  });
});
