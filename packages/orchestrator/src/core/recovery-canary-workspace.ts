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

/** Paperclip v916 company DELETE can violate a heartbeat-event FK. Dispose the whole isolated host instead. */
export function isDisposableRecoveryCanaryHost(environment: Readonly<Record<string, string | undefined>>): boolean {
  return environment["PAPERCLIP_E2E_DISPOSABLE_HOST"] === "1" &&
    environment["PAPERCLIP_INSTANCE_ID"] === "canary" &&
    /\/paperclip-canary-home\/?$/.test(environment["PAPERCLIP_HOME"] ?? "");
}
