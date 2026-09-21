import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CiCheckStatus = "success" | "pending" | "stalled" | "failed" | "unknown";
export const CI_STALL_TIMEOUT_MS = 90 * 60 * 1_000;
export type PullRequestState = "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";
export type GitHubInspectionStatus = "observed" | "unavailable";
export type GitHubInspectionUnavailableReason = "authentication" | "not_found" | "timeout" | "command_failed";

export interface CheckItem {
  name?: string;
  state?: string;
  bucket?: string;
  workflow?: string;
  startedAt?: string;
}

export type MergeableStatus = "mergeable" | "conflicting" | "unknown";

export interface PullRequestDetails {
  state: PullRequestState;
  merged: boolean;
  ciStatus: CiCheckStatus;
  /** Whether the run-scoped GitHub broker successfully inspected this PR. */
  inspectionStatus: GitHubInspectionStatus;
  /** Present only when the run-scoped GitHub inspection could not be performed. */
  unavailableReason?: GitHubInspectionUnavailableReason;
  mergeableStatus?: MergeableStatus;
  /** Immutable GitHub head used to fence review decisions to one revision. */
  headSha?: string;
  /** PR branch that remediation must continue on instead of the repository default branch. */
  headRefName?: string;
}

export interface GitHubCommandOutput {
  stdout: string;
  stderr: string;
}

export interface GitHubCommandOptions {
  readonly cwd?: string;
  /** Resolved adapter environment, including Paperclip's run-scoped GitHub launcher. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam; production uses the Paperclip-provided `gh` launcher on PATH. */
  readonly commandRunner?: GitHubCommandRunner;
}

/**
 * Runs `gh` without a shell so a provider-supplied PR URL is always an argument,
 * never executable syntax. The resolved environment is mandatory in production:
 * Paperclip v2026.916 injects its run-scoped GitHub broker there.
 */
export type GitHubCommandRunner = (
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }>,
) => Promise<GitHubCommandOutput>;

type GitHubCommandInput = string | GitHubCommandOptions | undefined;

interface GitHubCommandFailure {
  readonly reason: GitHubInspectionUnavailableReason;
  readonly output: GitHubCommandOutput;
}

type GitHubCommandResult =
  | { readonly ok: true; readonly output: GitHubCommandOutput }
  | { readonly ok: false; readonly failure: GitHubCommandFailure };

function normalizeOptions(input: GitHubCommandInput): Required<Pick<GitHubCommandOptions, "cwd">> & GitHubCommandOptions {
  return typeof input === "string"
    ? { cwd: input }
    : { cwd: input?.cwd || process.cwd(), ...input };
}

function resolvedCommandEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...process.env, ...env };
}

function commandFailure(error: unknown): GitHubCommandFailure {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const stdout = typeof record["stdout"] === "string" ? record["stdout"] : "";
  const stderr = typeof record["stderr"] === "string" ? record["stderr"] : "";
  const message = [error instanceof Error ? error.message : String(error), stderr].join(" ").toLowerCase();
  const timedOut = record["killed"] === true || record["code"] === "ETIMEDOUT" || record["signal"] === "SIGTERM";
  const reason: GitHubInspectionUnavailableReason = timedOut
    ? "timeout"
    : /authentication|required|bad credentials|not logged in|401|403/.test(message)
      ? "authentication"
      : /not found|could not resolve|unknown repository|404/.test(message)
        ? "not_found"
        : "command_failed";
  return { reason, output: { stdout, stderr } };
}

async function runGh(
  args: readonly string[],
  input: GitHubCommandInput,
  timeoutMs: number,
): Promise<GitHubCommandResult> {
  const options = normalizeOptions(input);
  const commandOptions = {
    cwd: options.cwd,
    env: resolvedCommandEnvironment(options.env),
    timeoutMs,
  };
  const runner: GitHubCommandRunner = options.commandRunner || (async (commandArgs, runnerOptions) => {
    const output = await execFileAsync("gh", [...commandArgs], {
      cwd: runnerOptions.cwd,
      env: runnerOptions.env,
      timeout: runnerOptions.timeoutMs,
      maxBuffer: 1_024 * 1_024,
    });
    return { stdout: output.stdout, stderr: output.stderr };
  });
  try {
    return { ok: true, output: await runner(args, commandOptions) };
  } catch (error) {
    return { ok: false, failure: commandFailure(error) };
  }
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value.trim());
  } catch {
    return undefined;
  }
}

function readPullRequestState(value: unknown): PullRequestState {
  switch (typeof value === "string" ? value.toUpperCase() : "") {
    case "OPEN": return "OPEN";
    case "MERGED": return "MERGED";
    case "CLOSED": return "CLOSED";
    default: return "UNKNOWN";
  }
}

function textField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mergeableStatus(value: unknown): MergeableStatus {
  switch (String(value || "").toUpperCase()) {
    case "MERGEABLE": return "mergeable";
    case "CONFLICTING": return "conflicting";
    default: return "unknown";
  }
}

export function evaluateChecks(checks: CheckItem[], now = Date.now()): CiCheckStatus {
  if (!Array.isArray(checks) || checks.length === 0) return "pending";

  let hasPending = false;
  let hasFreshPending = false;
  for (const check of checks) {
    const bucket = (check.bucket || "").toLowerCase();
    const state = (check.state || "").toUpperCase();
    if (bucket === "fail" || state === "FAILURE" || state === "ERROR" || state === "CANCELLED") return "failed";
    if (bucket === "pending" || state === "PENDING" || state === "IN_PROGRESS" || state === "QUEUED") {
      hasPending = true;
      const startedAt = typeof check.startedAt === "string" ? Date.parse(check.startedAt) : NaN;
      if (!Number.isFinite(startedAt) || now - startedAt < CI_STALL_TIMEOUT_MS) hasFreshPending = true;
    }
  }
  return hasPending ? (hasFreshPending ? "pending" : "stalled") : "success";
}

export async function listPullRequestChangedFiles(prUrl: string, options?: GitHubCommandInput): Promise<string[]> {
  const result = await runGh(["pr", "diff", prUrl, "--name-only"], options, 5_000);
  return result.ok
    ? result.output.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
}

/** Full PR patch for informational scope checks. Empty when brokered GitHub access is unavailable. */
export async function getPullRequestPatch(prUrl: string, options?: GitHubCommandInput): Promise<string> {
  const result = await runGh(["pr", "diff", prUrl], options, 8_000);
  return result.ok ? result.output.stdout : "";
}

export async function getPullRequestDetails(prUrl: string, options?: GitHubCommandInput): Promise<PullRequestDetails> {
  const view = await runGh(
    ["pr", "view", prUrl, "--json", "state,mergedAt,mergeable,mergeStateStatus,headRefOid,headRefName"],
    options,
    3_000,
  );
  if (!view.ok) {
    return {
      state: "UNKNOWN", merged: false, ciStatus: "unknown", inspectionStatus: "unavailable", unavailableReason: view.failure.reason,
    };
  }

  const parsedView = parseJson(view.output.stdout);
  if (!parsedView || typeof parsedView !== "object" || Array.isArray(parsedView)) {
    return {
      state: "UNKNOWN", merged: false, ciStatus: "unknown", inspectionStatus: "unavailable", unavailableReason: "command_failed",
    };
  }
  const viewRecord = parsedView as Record<string, unknown>;
  const state = readPullRequestState(viewRecord["state"]);
  const merged = state === "MERGED" || Boolean(viewRecord["mergedAt"]);
  const headSha = textField(viewRecord, "headRefOid");
  const headRefName = textField(viewRecord, "headRefName");
  const base = {
    state: merged ? "MERGED" as const : state,
    merged,
    inspectionStatus: "observed" as const,
    mergeableStatus: mergeableStatus(viewRecord["mergeable"]),
    ...(headSha ? { headSha } : {}),
    ...(headRefName ? { headRefName } : {}),
  };
  if (merged) return { ...base, ciStatus: "success" };

  const checks = await runGh(
    ["pr", "checks", prUrl, "--json", "bucket,state,name,workflow,startedAt"],
    options,
    3_000,
  );
  const parsedChecks = parseJson(checks.ok ? checks.output.stdout : checks.failure.output.stdout);
  if (Array.isArray(parsedChecks)) return { ...base, ciStatus: evaluateChecks(parsedChecks as CheckItem[]) };

  // The PR itself was observed; unavailable checks must not be interpreted as passing or pending.
  return { ...base, ciStatus: "unknown" };
}

export async function getPullRequestCiStatus(prUrl: string, options?: GitHubCommandInput): Promise<CiCheckStatus> {
  return (await getPullRequestDetails(prUrl, options)).ciStatus;
}
