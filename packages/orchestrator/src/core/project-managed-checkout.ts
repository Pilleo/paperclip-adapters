import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type ManagedProjectCheckoutResult =
  | { readonly status: "ready" | "materialized"; readonly workspacePath: string }
  | { readonly status: "rejected"; readonly reason: "not_paperclip_managed_path" };

export interface ManagedProjectCheckoutInput {
  readonly instanceRoot: string;
  readonly companyId: string;
  readonly projectId: string;
  readonly workspacePath: string;
  readonly repoUrl: string;
  readonly defaultRef: string;
}

const inFlightMaterializations = new Map<string, Promise<ManagedProjectCheckoutResult>>();

function repoNameFromUrl(repoUrl: string): string {
  const normalized = repoUrl.trim().replace(/\/+$/, "");
  const finalSegment = normalized.split(/[/:]/).pop()?.replace(/\.git$/i, "") ?? "";
  if (!finalSegment || !/^[A-Za-z0-9._-]+$/.test(finalSegment)) {
    throw new Error("Project repository URL does not contain a safe repository name");
  }
  return finalSegment;
}

function safePathSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(value)) throw new Error(`${label} must be a Paperclip identifier`);
  return value;
}

/** The one shared base checkout path Paperclip owns for a managed project. */
export function managedProjectCheckoutPath(input: {
  readonly instanceRoot: string;
  readonly companyId: string;
  readonly projectId: string;
  readonly repoUrl: string;
}): string {
  return path.join(
    path.resolve(input.instanceRoot),
    "projects",
    safePathSegment(input.companyId, "companyId"),
    safePathSegment(input.projectId, "projectId"),
    repoNameFromUrl(input.repoUrl),
  );
}

async function isGitCheckout(workspacePath: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspacePath });
    return true;
  } catch {
    return false;
  }
}

async function materialize(input: ManagedProjectCheckoutInput): Promise<ManagedProjectCheckoutResult> {
  const expectedPath = managedProjectCheckoutPath(input);
  const workspacePath = path.resolve(input.workspacePath);
  if (workspacePath !== expectedPath) return { status: "rejected", reason: "not_paperclip_managed_path" };
  if (await isGitCheckout(workspacePath)) return { status: "ready", workspacePath };

  const existing = await fs.stat(workspacePath).catch(() => null);
  if (existing) {
    throw new Error(`Paperclip-managed checkout path exists but is not a Git checkout: ${workspacePath}`);
  }

  const parent = path.dirname(workspacePath);
  await fs.mkdir(parent, { recursive: true });
  const temporaryCheckout = await fs.mkdtemp(path.join(parent, `.${path.basename(workspacePath)}.clone-`));
  try {
    await execFileAsync("git", ["clone", "--branch", input.defaultRef, "--single-branch", input.repoUrl, temporaryCheckout], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    await fs.rename(temporaryCheckout, workspacePath);
    return { status: "materialized", workspacePath };
  } catch (error) {
    await fs.rm(temporaryCheckout, { recursive: true, force: true }).catch(() => undefined);
    if (await isGitCheckout(workspacePath)) return { status: "ready", workspacePath };
    throw error;
  }
}

/**
 * Compatibility bridge for a Paperclip company-scoped adapter heartbeat.
 *
 * Paperclip records a managed project path immediately, but its current public
 * API does not materialize that checkout until it starts an issue-scoped host
 * execution. The orchestrator schedules several projects from one company
 * heartbeat, so it must not call Git against that declared-but-missing path.
 * This bridge mirrors the host's atomic clone semantics only for the exact
 * Paperclip-owned path. Remove it when Paperclip exposes project workspace
 * realization to company-scoped adapters.
 */
export async function ensureManagedProjectCheckout(input: ManagedProjectCheckoutInput): Promise<ManagedProjectCheckoutResult> {
  const expectedPath = managedProjectCheckoutPath(input);
  const workspacePath = path.resolve(input.workspacePath);
  if (workspacePath !== expectedPath) return { status: "rejected", reason: "not_paperclip_managed_path" };
  const existing = inFlightMaterializations.get(workspacePath);
  if (existing) return existing;
  const attempt = materialize(input).finally(() => inFlightMaterializations.delete(workspacePath));
  inFlightMaterializations.set(workspacePath, attempt);
  return attempt;
}
