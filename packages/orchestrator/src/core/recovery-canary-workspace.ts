import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

/** A disposable checkout's project metadata must identify the repository it actually tests. */
export function buildRecoveryCanaryWorkspace(cwd: string, defaultRef: string) {
  return {
    name: "Canary local workspace",
    sourceType: "local_path" as const,
    cwd,
    repoUrl: "https://github.com/pilleo/paperclip-adapters.git",
    defaultRef,
    isPrimary: true,
  };
}

/** Clone from the remote, never the possibly unpushed/dirty adapter development checkout. */
export async function createRecoveryCanaryCheckout(home: string, repoUrl: string, ref: string): Promise<string> {
  const checkout = path.join(home, "recovery-canary-checkout");
  await run("git", ["clone", "--single-branch", "--branch", ref, repoUrl, checkout], { timeout: 60_000 });
  return checkout;
}
