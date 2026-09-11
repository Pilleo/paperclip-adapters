import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../.github/workflows/paperclip-ci.yml", import.meta.url), "utf8");

function extractFixture() {
  const match = workflow.match(/cat >.*?<<'EOF'\n([\s\S]*?)\n\s+EOF/);
  assert.ok(match, "workflow must contain the server-side gh fixture");
  return match[1].split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
}

test("the server-owned GitHub fixture matches only the exact canary argv", () => {
  assert.match(workflow, /\[\s*\"\$1\" = \"pr\"\s*\] && \[\s*\"\$2\" = \"list\"/);
  assert.ok(workflow.includes('[ "$3" = "--repo" ] && [ "$4" = "pilleo/paperclip-adapters" ]'));
  assert.ok(workflow.includes('[ "$5" = "--state" ] && [ "$6" = "all" ]'));
  assert.ok(workflow.includes('[ "$7" = "--limit" ] && [ "$8" = "50" ]'));
  assert.ok(workflow.includes('[ "$9" = "--json" ]'));
  assert.ok(workflow.includes('[ "${10}" = "number,title,state,headRefName,headRefOid,baseRefName,mergedAt,url,files" ]'));
  assert.ok(workflow.includes('[ "$1" = "pr" ] && [ "$2" = "checks" ] && [ "$3" = "991" ]'));
  assert.ok(workflow.includes('[ "$4" = "--json" ] && [ "$5" = "state,bucket,name" ]'));
  assert.doesNotMatch(workflow, /\*\"pr (?:list|view|checks)\"\*/);
});

test("the server startup fails closed when onboarding never becomes healthy", () => {
  assert.match(workflow, /ONBOARD_HEALTHY=false/);
  assert.match(workflow, /ONBOARD_HEALTHY=true/);
  assert.match(workflow, /if \[ \"\$ONBOARD_HEALTHY\" != \"true\" \]/);
  assert.match(workflow, /Onboarding did not become healthy/);
});

test("the fixture rejects wrong repositories, extra arguments, and mutating commands", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-gh-fixture-"));
  const fixture = path.join(directory, "gh");
  try {
    fs.writeFileSync(fixture, extractFixture(), { mode: 0o755 });
    const validList = execFileSync(fixture, ["pr", "list", "--repo", "pilleo/paperclip-adapters", "--state", "all", "--limit", "50", "--json", "number,title,state,headRefName,headRefOid,baseRefName,mergedAt,url,files"], { encoding: "utf8" });
    assert.match(validList, /\"number\":991/);
    const validChecks = execFileSync(fixture, ["pr", "checks", "991", "--json", "state,bucket,name"], { encoding: "utf8" });
    assert.match(validChecks, /\"state\":\"SUCCESS\"/);
    for (const args of [
      ["pr", "list", "--repo", "attacker/other", "--state", "all", "--limit", "50", "--json", "number,title,state,headRefName,headRefOid,baseRefName,mergedAt,url,files"],
      ["pr", "checks", "991", "--json", "state,bucket,name", "--web"],
      ["pr", "merge", "991", "--merge"],
    ]) {
      assert.throws(() => execFileSync(fixture, args, { encoding: "utf8", stdio: "pipe" }));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
