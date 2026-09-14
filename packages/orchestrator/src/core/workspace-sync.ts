export type WorkspaceSyncPolicy = Readonly<{
  repoUrl: string;
  defaultRef: string;
}>;

export type WorkspaceSyncObservation =
  | Readonly<{ kind: "dirty"; branch: string; headSha: string }>
  | Readonly<{ kind: "clean_synced"; branch: string; headSha: string; remoteHeadSha: string }>
  | Readonly<{ kind: "clean_behind"; branch: string; headSha: string; remoteHeadSha: string }>
  | Readonly<{ kind: "clean_non_default"; branch: string; headSha: string }>
  | Readonly<{ kind: "local_ahead"; branch: string; headSha: string; remoteHeadSha: string }>
  | Readonly<{ kind: "diverged"; branch: string; headSha: string; remoteHeadSha: string }>
  | Readonly<{ kind: "default_ref_missing"; detail: string }>
  | Readonly<{ kind: "pull_failed"; detail: string }>
  | Readonly<{ kind: "remote_unavailable"; branch: string; headSha: string; detail: string }>
  | Readonly<{ kind: "inspection_failed"; detail: string }>;

export type WorkspaceSyncDecision =
  | Readonly<{ action: "ready" }>
  | Readonly<{ action: "fast_forward"; repoUrl: string; defaultRef: string }>
  | Readonly<{ action: "hold"; reason: string }>;

export type WorkspaceGitRunner = (args: readonly string[], workspacePath: string) => Promise<string>;

async function defaultGitRunner(args: readonly string[], workspacePath: string): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd: workspacePath });
  return result.stdout.trim();
}

async function isAncestor(
  runGit: WorkspaceGitRunner,
  workspacePath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", ancestor, descendant], workspacePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only checkout inspection. It intentionally uses the existing remote
 * tracking ref; a stale or missing ref is not evidence that a pull is safe.
 */
export async function observeWorkspaceSync(input: Readonly<{
  workspacePath: string;
  policy: WorkspaceSyncPolicy;
  runGit?: WorkspaceGitRunner;
}>): Promise<WorkspaceSyncObservation> {
  const runGit = input.runGit ?? defaultGitRunner;
  try {
    const [status, branch, headSha] = await Promise.all([
      runGit(["status", "--porcelain"], input.workspacePath),
      runGit(["branch", "--show-current"], input.workspacePath),
      runGit(["rev-parse", "HEAD"], input.workspacePath),
    ]);
    if (status.trim()) return { kind: "dirty", branch: branch.trim(), headSha: headSha.trim() };
    if (branch.trim() !== input.policy.defaultRef) return { kind: "clean_non_default", branch: branch.trim(), headSha: headSha.trim() };

    const temporaryRef = `refs/paperclip-sync/${input.policy.defaultRef.replace(/[^A-Za-z0-9._-]/g, "-")}`;
    let remoteHeadSha: string;
    try {
      await runGit(["fetch", "--no-tags", input.policy.repoUrl, `${input.policy.defaultRef}:${temporaryRef}`], input.workspacePath);
      remoteHeadSha = await runGit(["rev-parse", temporaryRef], input.workspacePath);
    } catch (error: unknown) {
      return { kind: "default_ref_missing", detail: String(error) };
    } finally {
      await runGit(["update-ref", "-d", temporaryRef], input.workspacePath).catch(() => undefined);
    }
    if (headSha.trim() === remoteHeadSha.trim()) return { kind: "clean_synced", branch: branch.trim(), headSha: headSha.trim(), remoteHeadSha: remoteHeadSha.trim() };
    if (await isAncestor(runGit, input.workspacePath, headSha.trim(), remoteHeadSha.trim())) return { kind: "clean_behind", branch: branch.trim(), headSha: headSha.trim(), remoteHeadSha: remoteHeadSha.trim() };
    if (await isAncestor(runGit, input.workspacePath, remoteHeadSha.trim(), headSha.trim())) return { kind: "local_ahead", branch: branch.trim(), headSha: headSha.trim(), remoteHeadSha: remoteHeadSha.trim() };
    return { kind: "diverged", branch: branch.trim(), headSha: headSha.trim(), remoteHeadSha: remoteHeadSha.trim() };
  } catch (error: unknown) {
    return { kind: "inspection_failed", detail: String(error) };
  }
}

/** The only checkout mutation allowed by the workspace synchronization gate. */
export async function synchronizeWorkspace(input: Readonly<{
  workspacePath: string;
  policy: WorkspaceSyncPolicy;
  observation: WorkspaceSyncObservation;
  runGit?: WorkspaceGitRunner;
}>): Promise<void> {
  if (input.observation.kind !== "clean_behind") {
    throw new Error(`Refusing workspace mutation for observation ${input.observation.kind}`);
  }
  const runGit = input.runGit ?? defaultGitRunner;
  await runGit(["pull", "--ff-only", input.policy.repoUrl, input.policy.defaultRef], input.workspacePath);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled workspace synchronization observation: ${JSON.stringify(value)}`);
}

/**
 * Decides whether fresh dispatch may synchronize a project checkout. This
 * reducer deliberately has no permissive fallback: a missing policy or an
 * observation outside the clean configured branch is a hold.
 */
export function evaluateWorkspaceSync(input: Readonly<{
  observation: WorkspaceSyncObservation;
  policy: WorkspaceSyncPolicy | null;
}>): WorkspaceSyncDecision {
  if (!input.policy) {
    return { action: "hold", reason: "Paperclip project synchronization policy is missing." };
  }

  switch (input.observation.kind) {
    case "clean_synced":
      return { action: "ready" };
    case "clean_behind":
      return {
        action: "fast_forward",
        repoUrl: input.policy.repoUrl,
        defaultRef: input.policy.defaultRef,
      };
    case "dirty":
      return { action: "hold", reason: "Project checkout has uncommitted changes." };
    case "clean_non_default":
      return { action: "hold", reason: "Project checkout is not on the configured default branch." };
    case "local_ahead":
      return { action: "hold", reason: "Project checkout is ahead of the configured remote branch." };
    case "diverged":
      return { action: "hold", reason: "Project checkout diverged from the configured remote branch." };
    case "default_ref_missing":
      return { action: "hold", reason: `Configured default ref is unavailable: ${input.observation.detail}` };
    case "pull_failed":
      return { action: "hold", reason: `Fast-forward pull failed: ${input.observation.detail}` };
    case "remote_unavailable":
      return { action: "hold", reason: `Configured remote is unavailable: ${input.observation.detail}` };
    case "inspection_failed":
      return { action: "hold", reason: `Checkout inspection failed: ${input.observation.detail}` };
    default:
      return assertNever(input.observation);
  }
}
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
