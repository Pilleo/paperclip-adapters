import type { ExecFileOptions } from "node:child_process";

/**
 * A company heartbeat must eventually return even when a remote Git server or
 * SSH transport stalls. Apply this to individual Git subprocesses only; do
 * not race a whole project state machine because that would leave mutations
 * running after the heartbeat has reported completion.
 */
export const GIT_COMMAND_TIMEOUT_MS = 30_000;

export function gitCommandOptions(): Readonly<Pick<ExecFileOptions, "timeout" | "killSignal">> {
  return Object.freeze({ timeout: GIT_COMMAND_TIMEOUT_MS, killSignal: "SIGKILL" });
}
