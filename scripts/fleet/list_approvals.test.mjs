import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "list_approvals.sh");
const execFileAsync = promisify(execFile);
const fixtures = [
  { id: "start-1", type: "request_board_approval", status: "pending", title: null, payload: { action: "task_start", identifier: "MAZ-1241", title: "Show metadata", issueId: "issue-1241" } },
  { id: "merge-1", type: "request_board_approval", status: "approved", title: null, payload: { action: "task_merge", identifier: "MAZ-1240", title: "Merge metadata", issueId: "issue-1240" } },
  { id: "legacy-1", type: "task_start_approval", status: "rejected", title: "Start legacy task", payload: {} },
];

async function run(filter = "all") {
  const bin = mkdtempSync(resolve(tmpdir(), "paperclip-approvals-"));
  const curl = resolve(bin, "curl");
  writeFileSync(curl, `#!/usr/bin/node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(fixtures))});\n`);
  chmodSync(curl, 0o755);
  try {
    const result = await execFileAsync("bash", [script, filter], {
      encoding: "utf8",
      timeout: 3_000,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    });
    // Skip the first line (status message), parse each remaining line as JSON
    return result.stdout.split("\n").slice(1).filter(line => line.trim()).map(line => JSON.parse(line));
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test("executes the real script and enriches every streamed approval object", async () => {
  assert.deepEqual((await run()).map(({ id, action, identifier, title }) => ({ id, action, identifier, title })), [
    { id: "start-1", action: "task_start", identifier: "MAZ-1241", title: "Show metadata" },
    { id: "merge-1", action: "task_merge", identifier: "MAZ-1240", title: "Merge metadata" },
    { id: "legacy-1", action: "N/A", identifier: "N/A", title: "Start legacy task" },
  ]);
});

test("passes the status filter through the real script", async () => {
  assert.deepEqual((await run("pending")).map(({ id }) => id), ["start-1"]);
  assert.deepEqual((await run("approved")).map(({ id }) => id), ["merge-1"]);
  assert.deepEqual((await run("rejected")).map(({ id }) => id), ["legacy-1"]);
});
