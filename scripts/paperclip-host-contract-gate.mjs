import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const supported = [
  "stable_child_jules_v4_executor",
  "stable_child_jules_v4_create",
  "stable_child_jules_v4_create_lost",
  "stable_child_executor_pr_board",
  "stable_child_executor_pr_probe",
  "stable_child_executor_pr_withdraw",
];
const requested = process.argv.filter((arg) => arg.startsWith("--scenario=")).map((arg) => arg.slice("--scenario=".length));
if (requested.some((scenario) => !supported.includes(scenario))) {
  throw new Error(`Only supported positive native contracts may enter the CI gate: ${requested.join(", ")}`);
}
const selected = requested.length ? requested : supported;
const reportDir = process.env.CONTRACT_REPORT_DIR;
if (!reportDir) throw new Error("CONTRACT_REPORT_DIR must name a disposable directory for sanitized reports");
await mkdir(reportDir, { recursive: true });
const timeoutMs = Number(process.env.CONTRACT_SCENARIO_TIMEOUT_MS ?? 300_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) {
  throw new Error("CONTRACT_SCENARIO_TIMEOUT_MS must be an integer between 1 and 900000");
}

const scenarios = [];
for (const scenario of selected) {
  const freshReportDir = await mkdtemp(path.join(reportDir, `${scenario}-`));
  const run = await new Promise((resolve) => {
    const child = spawn("pnpm", ["test:contract:plan-handback", `--scenario=${scenario}`, "--require-safe"], {
      env: { ...process.env, CONTRACT_REPORT_DIR: freshReportDir },
      stdio: "inherit",
      detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") console.error("Contract timeout termination failed", error); }
      }
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); resolve({ exit: 1, error: error.code ?? "launch_error", timedOut }); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exit: code ?? (signal ? 1 : 0), timedOut });
    });
  });
  let report;
  try {
    report = JSON.parse(await readFile(path.join(freshReportDir, `${scenario}.json`), "utf8"));
  } catch {
    report = { scenario, result: "missing_report", safetyGate: "not_established" };
  }
  const validIdentity = report.scenario === scenario && report.version === "2026.916.0";
  scenarios.push({ scenario, result: run.timedOut ? "timeout" : run.error ? "launch_error" :
    !validIdentity && report.result !== "missing_report" ? "invalid_report" : report.result,
    safetyGate: validIdentity && !run.timedOut && !run.error ? report.safetyGate : "not_established", exit: run.exit });
}
const integrationAllowed = scenarios.every((scenario) => scenario.exit === 0 && scenario.result === "observed" && scenario.safetyGate === "pass");
const summary = { version: "2026.916.0", integrationAllowed, scenarios };
await writeFile(path.join(reportDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log("SUPPORTED_HOST_CONTRACT_SUMMARY", JSON.stringify(summary));
if (!integrationAllowed) process.exitCode = 1;
