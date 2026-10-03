import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/check-no-secrets.mjs");
function scan(contents) {
  const root = mkdtempSync(path.join(tmpdir(), "secret-guard-test-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/runtime.ts"), contents);
    execFileSync("git", ["add", "src/runtime.ts"], { cwd: root });
    return spawnSync(process.execPath, [script, "--all"], { cwd: root, encoding: "utf8" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a runtime-auth reference is not a committed Paperclip credential", () => {
  const result = scan("const env = { PAPERCLIP_API_KEY: ctx.authToken };\n");
  assert.equal(result.status, 0, result.stderr);
});

test("literal credential assignments still fail without printing the value", () => {
  for (const key of ["PAPERCLIP_API_KEY", "PAPERCLIP_AGENT_TOKEN", "JULES_API_KEY"]) {
    const value = "owned-fake-credential-for-secret-guard-test";
    const result = scan(`${key}=${value}\n`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/runtime.ts:1/);
    assert.ok(!result.stderr.includes(value));
  }
});

test("a similar-looking literal must not get the runtime-reference exemption", () => {
  const key = ["PAPERCLIP", "API_KEY"].join("_");
  const result = scan(`${key}=ctx.authTokenFakeCredential\n`);
  assert.equal(result.status, 1);
});
