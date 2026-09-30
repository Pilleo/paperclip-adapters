import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { reloadAndVerify } from "./task-drain-reload.mjs";

const exec = promisify(execFile);
const args = process.argv.slice(2), options = new Map();
const allowed = new Set(["--journal", "--reconcile-company", "--reconcile-agent", "--wait-seconds"]);
for (let i = 0; i < args.length; i += 2) {
  if (!allowed.has(args[i]) || !args[i + 1] || options.has(args[i])) throw Error("Invalid reload arguments");
  options.set(args[i], args[i + 1]);
}
const apiUrl = new URL(process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100");
if (!["http:", "https:"].includes(apiUrl.protocol) || !["localhost", "127.0.0.1"].includes(apiUrl.hostname) ||
    apiUrl.username || apiUrl.password || apiUrl.pathname !== "/" || apiUrl.search || apiUrl.hash) {
  throw Error("Reload API must use credential-free loopback origin");
}
const journalPath = options.get("--journal"), companyId = options.get("--reconcile-company"), agentId = options.get("--reconcile-agent");
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
if (!journalPath?.startsWith("/tmp/") || !uuid.test(companyId ?? "") || !uuid.test(agentId ?? "")) {
  throw Error("Usage: reload_adapters.mjs --journal /tmp/private-dir/receipt.jsonl --reconcile-company UUID --reconcile-agent UUID [--wait-seconds 900]");
}
const waitSeconds = Number(options.get("--wait-seconds") ?? 900);
if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) throw Error("Invalid reload wait seconds");
const directory = await lstat(path.dirname(journalPath));
if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)) {
  throw Error("Reload journal directory must already exist and be owner-only");
}
const journal = await open(journalPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
const record = async (entry) => { await journal.writeFile(`${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`); await journal.sync(); };
const request = async (method, route, body) => {
  const response = await fetch(`${apiUrl.origin}${route}`, { method, redirect: "error",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw Error(`Native ${method} ${route} returned ${response.status}`);
  return response.json();
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let restartSince;
try {
  const result = await reloadAndVerify({ request, waitMs: waitSeconds * 1000, record,
    restart: async () => {
      restartSince = new Date().toISOString();
      try { await exec("systemctl", ["--user", "restart", "paperclipai"], { timeout: 60_000, maxBuffer: 8192 }); }
      catch { throw Error("paperclipai restart outcome is unverified; inspect the journal instead of repeating it"); }
    },
    waitReady: async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try { await request("GET", "/api/health"); return; }
        catch (error) { await record({ event: "waiting_for_replacement_api", errorType: error.name }); await sleep(1000); }
      }
      throw Error("Replacement Paperclip API did not become ready");
    },
    verifyLoaded: async () => {
      const { stdout } = await exec("journalctl", ["--user", "-u", "paperclipai", "--since", restartSince,
        "--no-pager", "-o", "cat"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
      const lines = stdout.split("\n").filter((line) => line.includes("Loading external adapter package"));
      for (const name of ["orchestrator", "jules"]) {
        const entry = fileURLToPath(new URL(`../../packages/${name}/dist/index.js`, import.meta.url));
        if (!lines.some((line) => line.includes(entry))) throw Error(`Startup did not load ${name} dist/index.js`);
      }
      await record({ event: "required_packages_loaded", packages: ["orchestrator", "jules"] });
    },
    waitReconciled: async () => {
      const deadline = Date.now() + 900_000;
      while (Date.now() < deadline) {
        const runs = await request("GET", `/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}&limit=10`);
        if (!Array.isArray(runs)) throw Error("Invalid reconciliation run list");
        const fresh = runs.filter((run) => run.agentId === agentId && typeof run.startedAt === "string" &&
          Date.parse(run.startedAt) >= Date.parse(restartSince));
        if (fresh.some((run) => ["failed", "timed_out", "cancelled"].includes(run.status))) {
          throw Error("A post-reload reconciliation failed; inspect exact run before proceeding");
        }
        const succeeded = fresh.find((run) => run.status === "succeeded");
        if (succeeded) return { runId: succeeded.id, finishedAt: succeeded.finishedAt };
        await sleep(5000);
      }
      throw Error("No succeeding post-reload reconciliation heartbeat observed");
    },
  });
  console.log(JSON.stringify({ status: "ready", ...result, journalPath }));
} catch (error) {
  await record({ event: "reload_failed", error: error.message });
  console.error(`Verified reload failed: ${error.message}`);
  process.exitCode = 1;
} finally { await journal.close(); }
