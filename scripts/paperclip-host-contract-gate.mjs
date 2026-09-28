import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const supported = [
  "stable_child_jules_v4_executor",
  "stable_child_executor_pr_board",
  "stable_child_executor_pr_probe",
];
const requested = process.argv.filter((arg) => arg.startsWith("--scenario=")).map((arg) => arg.slice("--scenario=".length));
if (requested.some((scenario) => !supported.includes(scenario))) {
  throw new Error(`Only supported positive native contracts may enter the CI gate: ${requested.join(", ")}`);
}
const selected = requested.length ? requested : supported;
const reportDir = process.env.CONTRACT_REPORT_DIR;
if (!reportDir) throw new Error("CONTRACT_REPORT_DIR must name a disposable directory for sanitized reports");
await mkdir(reportDir, { recursive: true });

const scenarios = [];
for (const scenario of selected) {
  const exit = await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["test:contract:plan-handback", `--scenario=${scenario}`, "--require-safe"], {
      env: { ...process.env, CONTRACT_REPORT_DIR: reportDir },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  let report;
  try {
    report = JSON.parse(await readFile(path.join(reportDir, `${scenario}.json`), "utf8"));
  } catch (error) {
    report = { scenario, result: "missing_report", safetyGate: "not_established",
      error: error instanceof Error ? error.message : String(error) };
  }
  scenarios.push({ scenario, result: report.result, safetyGate: report.safetyGate, exit });
}
const integrationAllowed = scenarios.every((scenario) => scenario.exit === 0 && scenario.result === "observed" && scenario.safetyGate === "pass");
const summary = { version: "2026.916.0", integrationAllowed, scenarios };
await writeFile(path.join(reportDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log("SUPPORTED_HOST_CONTRACT_SUMMARY", JSON.stringify(summary));
if (!integrationAllowed) process.exitCode = 1;
