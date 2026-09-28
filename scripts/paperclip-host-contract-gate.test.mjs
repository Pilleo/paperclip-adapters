import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const gate = path.resolve("scripts/paperclip-host-contract-gate.mjs");

async function runGate(fixtureExit, fixtureSafetyGate, args = []) {
  const home = await mkdtemp(path.join(tmpdir(), "host-gate-test-"));
  const bin = path.join(home, "bin");
  await mkdir(bin);
  const pnpm = path.join(bin, "pnpm");
  await writeFile(pnpm, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const scenario = process.argv.find((arg) => arg.startsWith('--scenario='))?.slice(11);
const report = { scenario, result: 'observed', safetyGate: process.env.FIXTURE_SAFETY_GATE };
fs.writeFileSync(path.join(process.env.CONTRACT_REPORT_DIR, scenario + '.json'), JSON.stringify(report));
process.exit(Number(process.env.FIXTURE_EXIT));
`);
  await chmod(pnpm, 0o700);
  try {
    const child = spawn(process.execPath, [gate, ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONTRACT_REPORT_DIR: path.join(home, "reports"),
        FIXTURE_EXIT: String(fixtureExit), FIXTURE_SAFETY_GATE: fixtureSafetyGate },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (part) => { stdout += part.toString(); });
    child.stderr.on("data", (part) => { stderr += part.toString(); });
    const exit = await new Promise((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
    const summary = JSON.parse(await readFile(path.join(home, "reports", "summary.json"), "utf8"));
    return { exit, stdout, stderr, summary };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("supported-host contract gate refuses a completed but unsafe scenario", async () => {
  const result = await runGate(0, "fail", ["--scenario=stable_child_jules_v4_executor"]);
  assert.notEqual(result.exit, 0);
  assert.equal(result.summary.scenarios[0].safetyGate, "fail");
});

test("supported-host contract gate refuses harness failures and preserves a summary", async () => {
  const result = await runGate(1, "not_established", ["--scenario=stable_child_executor_pr_board"]);
  assert.notEqual(result.exit, 0);
  assert.equal(result.summary.scenarios[0].result, "observed");
});

test("supported-host contract gate succeeds only for selected positive safe scenarios", async () => {
  const result = await runGate(0, "pass", ["--scenario=stable_child_executor_pr_probe"]);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.summary.integrationAllowed, true);
});
