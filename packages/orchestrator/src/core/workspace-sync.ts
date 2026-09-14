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

/** Existing lifecycle reconciliation remains safe while held; only this gate
 * controls creation of new work, worker sessions, and reviewer dispatches. */
export function isFreshDispatchAllowed(decision: WorkspaceSyncDecision): boolean {
  return decision.action === "ready";
}

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

function fetchFailureObservation(error: unknown, branch: string, headSha: string): WorkspaceSyncObservation {
  const detail = String(error);
  // Git does not provide a machine-readable exit code that distinguishes a
  // missing remote ref from transport/auth failures. Keep the small, known
  // ref-missing vocabulary here and fail every other fetch failure closed as
  // a remote outage; never let an unavailable remote look repairable by pull.
  if (/could(?:n't| not) find remote ref|remote branch .+ not found/i.test(detail)) {
    return { kind: "default_ref_missing", detail };
  }
  return { kind: "remote_unavailable", branch, headSha, detail };
}

/**
 * Reads the configured remote directly rather than trusting the checkout's
 * `origin`. Fetching into a per-observation disposable ref avoids changing a
 * branch or remote while preventing concurrent heartbeats from sharing state.
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

    const temporaryRef = `refs/paperclip-sync/${input.policy.defaultRef.replace(/[^A-Za-z0-9._-]/g, "-")}-${randomUUID()}`;
    let remoteHeadSha: string;
    try {
      await runGit(["fetch", "--no-tags", input.policy.repoUrl, `${input.policy.defaultRef}:${temporaryRef}`], input.workspacePath);
      remoteHeadSha = await runGit(["rev-parse", temporaryRef], input.workspacePath);
    } catch (error: unknown) {
      return fetchFailureObservation(error, branch.trim(), headSha.trim());
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

/**
 * Performs the one allowed repair attempt and turns every outcome back into
 * the closed decision algebra consumed by the heartbeat. In particular, a
 * pull failure is not allowed to escape and skip lifecycle reconciliation.
 */
export async function reconcileWorkspaceSync(input: Readonly<{
  workspacePath: string;
  policy: WorkspaceSyncPolicy | null;
  runGit?: WorkspaceGitRunner;
}>): Promise<WorkspaceSyncDecision> {
  const runnerOption = input.runGit ? { runGit: input.runGit } : {};
  const initialObservation = input.policy
    ? await observeWorkspaceSync({ workspacePath: input.workspacePath, policy: input.policy, ...runnerOption })
    : { kind: "inspection_failed", detail: "Paperclip project workspace policy is missing." } as const;
  const initialDecision = evaluateWorkspaceSync({ policy: input.policy, observation: initialObservation });
  if (initialDecision.action !== "fast_forward" || !input.policy) return initialDecision;

  try {
    await synchronizeWorkspace({
      workspacePath: input.workspacePath,
      policy: input.policy,
      observation: initialObservation,
      ...runnerOption,
    });
  } catch (error: unknown) {
    return evaluateWorkspaceSync({
      policy: input.policy,
      observation: { kind: "pull_failed", detail: String(error) },
    });
  }

  return evaluateWorkspaceSync({
    policy: input.policy,
    observation: await observeWorkspaceSync({ workspacePath: input.workspacePath, policy: input.policy, ...runnerOption }),
  });
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
import { randomUUID } from "node:crypto";
