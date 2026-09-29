import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const gate = path.resolve("scripts/paperclip-host-contract-gate.mjs");

async function runGate(fixtureExit, fixtureSafetyGate, args = [], options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "host-gate-test-"));
  const bin = path.join(home, "bin");
  await mkdir(bin);
  const pnpm = path.join(bin, "pnpm");
  await writeFile(pnpm, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const scenario = process.argv.find((arg) => arg.startsWith('--scenario='))?.slice(11);
if (process.env.FIXTURE_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FIXTURE_DELAY));
if (process.env.FIXTURE_WRITE !== 'no') {
  const report = { scenario: process.env.FIXTURE_SCENARIO || scenario, version: process.env.FIXTURE_VERSION || '2026.916.0', result: 'observed', safetyGate: process.env.FIXTURE_SAFETY_GATE };
  fs.writeFileSync(path.join(process.env.CONTRACT_REPORT_DIR, scenario + '.json'), process.env.FIXTURE_MALFORMED === 'yes' ? '{invalid-json' : JSON.stringify(report));
}
process.exit(Number(process.env.FIXTURE_EXIT));
`);
  await chmod(pnpm, 0o700);
  try {
    const reportDir = path.join(home, "reports");
    await mkdir(reportDir);
    if (options.staleReport) {
      await writeFile(path.join(reportDir, "stable_child_executor_pr_board.json"), JSON.stringify({
        scenario: "stable_child_executor_pr_board", version: "2026.916.0", result: "observed", safetyGate: "pass",
      }));
    }
    const child = spawn(process.execPath, [gate, ...args], {
      env: { ...process.env, PATH: options.noPnpm ? home : `${bin}:${process.env.PATH}`, CONTRACT_REPORT_DIR: path.join(home, "reports"),
        FIXTURE_EXIT: String(fixtureExit), FIXTURE_SAFETY_GATE: fixtureSafetyGate,
        FIXTURE_WRITE: options.writeReport === false ? "no" : "yes",
        FIXTURE_SCENARIO: options.reportScenario ?? "", FIXTURE_VERSION: options.reportVersion ?? "",
        FIXTURE_DELAY: String(options.delayMs ?? 0),
        FIXTURE_MALFORMED: options.malformedReport ? "yes" : "no",
        CONTRACT_SCENARIO_TIMEOUT_MS: String(options.timeoutMs ?? 120_000) },
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

test("historical parent-card typed withdrawal and v2 child review is a required positive contract", async () => {
  const result = await runGate(0, "pass", ["--scenario=stable_child_executor_pr_withdraw"]);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.summary.scenarios[0].scenario, "stable_child_executor_pr_withdraw");
});

test("actual provider session creation, plan approval and PR delivery is a required positive contract", async () => {
  const result = await runGate(0, "pass", ["--scenario=stable_child_jules_v4_create"]);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.summary.scenarios[0].scenario, "stable_child_jules_v4_create");
});

test("accepted provider create with a lost response must use typed recovery before continuation", async () => {
  const result = await runGate(0, "pass", ["--scenario=stable_child_jules_v4_create_lost"]);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.summary.scenarios[0].scenario, "stable_child_jules_v4_create_lost");
});

test("full A B C native lifecycle must reach three externally merged and terminal PRs", async () => {
  const result = await runGate(0, "pass", ["--scenario=stable_child_chain_abc_complete"]);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.summary.scenarios[0].scenario, "stable_child_chain_abc_complete");
});

test("full A B C must still complete after B's accepted provider create response is lost", async () => {
  const result = await runGate(0, "pass", ["--scenario=stable_child_chain_abc_lost_b_create"]);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.summary.scenarios[0].scenario, "stable_child_chain_abc_lost_b_create");
});

test("full A B C must still complete after B's accepted plan approval response is lost", async () => {
  const result = await runGate(0, "pass", ["--scenario=stable_child_chain_abc_lost_b_approval"]);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.summary.scenarios[0].scenario, "stable_child_chain_abc_lost_b_approval");
});

test("missing fresh report cannot be replaced with a stale successful report", async () => {
  const result = await runGate(0, "pass", ["--scenario=stable_child_executor_pr_board"], { staleReport: true, writeReport: false });
  assert.notEqual(result.exit, 0);
  assert.equal(result.summary.scenarios[0].result, "missing_report");
});

test("a report for a different scenario is not evidence of this scenario", async () => {
  const result = await runGate(0, "pass", ["--scenario=stable_child_executor_pr_board"], { reportScenario: "stable_child_jules_v4_executor" });
  assert.notEqual(result.exit, 0);
});

test("a report from a different host version is not a supported-host contract", async () => {
  const result = await runGate(0, "pass", ["--scenario=stable_child_executor_pr_board"], { reportVersion: "2026.831.1" });
  assert.notEqual(result.exit, 0);
});

test("a hung contract has a bounded failure and emits a summary", async () => {
  const result = await runGate(0, "pass", ["--scenario=stable_child_executor_pr_board"], { delayMs: 1500, timeoutMs: 100 });
  assert.notEqual(result.exit, 0);
  assert.equal(result.summary.scenarios[0].result, "timeout");
});

test("a contract launch error still produces a failing summary", async () => {
  const result = await runGate(0, "pass", ["--scenario=stable_child_executor_pr_board"], { noPnpm: true });
  assert.notEqual(result.exit, 0);
  assert.equal(result.summary.scenarios[0].result, "launch_error");
});

test("malformed scenario JSON cannot be a successful report", async () => {
  const result = await runGate(0, "pass", ["--scenario=stable_child_executor_pr_board"], { malformedReport: true });
  assert.notEqual(result.exit, 0);
  assert.equal(result.summary.scenarios[0].result, "missing_report");
});
