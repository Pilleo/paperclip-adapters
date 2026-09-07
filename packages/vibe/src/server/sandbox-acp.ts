import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import process from "node:process";
import {
  buildLocalProcessSandboxSpawnTarget,
  parseLocalProcessNetworkAllowlist,
  type LocalProcessSandboxOptions,
} from "@paperclipai/adapter-utils/local-process-sandbox";

/**
 * Starts Vibe ACP behind Paperclip's existing Bubblewrap implementation.
 *
 * ACPX currently launches provider processes itself and does not apply the
 * local-process scopes supported by the Codex CLI lane. This small adapter
 * launcher is deliberately kept here until ACPX grows that capability. It
 * speaks ACP transparently by inheriting all three stdio streams.
 */
export async function runSandboxedVibeAcp(options: {
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  filesystemScope: "workspace" | null;
  networkScope: "deny" | "allowlist" | null;
  networkAllowlist: string[];
  managedPaths?: LocalProcessSandboxOptions["managedPaths"];
}): Promise<number | null> {
  if (!options.filesystemScope && !options.networkScope) {
    throw new Error("Sandboxed Vibe ACP requires filesystemScope or networkScope.");
  }

  const executable = (() => {
    try {
      return execFileSync("which", [options.command], { encoding: "utf8" }).trim() || options.command;
    } catch {
      return options.command;
    }
  })();
  const target = await buildLocalProcessSandboxSpawnTarget({
    executable,
    args: [],
    cwd: options.cwd,
    options: {
      workspaceDir: options.cwd,
      filesystemScope: options.filesystemScope,
      networkScope: options.networkScope,
      networkAllowlist: parseLocalProcessNetworkAllowlist(options.networkAllowlist),
      managedPaths: options.managedPaths ?? [],
      homeDir: options.cwd,
      command: "bwrap",
    },
  });

  const child = spawn(target.command, target.args, {
    cwd: target.cwd,
    env: { ...options.env, ...target.env },
    stdio: "inherit",
  });

  const forward = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGTERM", forward);
  process.on("SIGINT", forward);

  try {
    return await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
  } finally {
    process.off("SIGTERM", forward);
    process.off("SIGINT", forward);
    await target.cleanup?.();
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Sandbox launcher requires ${name}.`);
  return value;
}

/** CLI entrypoint used as ACPX's agentCommand. */
export async function main(): Promise<void> {
  const command = requiredEnv("PAPERCLIP_VIBE_ACP_COMMAND");
  const cwd = requiredEnv("PAPERCLIP_VIBE_SANDBOX_CWD");
  const filesystemScope = process.env["PAPERCLIP_VIBE_FILESYSTEM_SCOPE"] === "workspace" ? "workspace" : null;
  const networkScope = process.env["PAPERCLIP_VIBE_NETWORK_SCOPE"] === "deny"
    ? "deny"
    : process.env["PAPERCLIP_VIBE_NETWORK_SCOPE"] === "allowlist"
      ? "allowlist"
      : null;
  const networkAllowlist = JSON.parse(process.env["PAPERCLIP_VIBE_NETWORK_ALLOWLIST"] ?? "[]") as string[];
  const code = await runSandboxedVibeAcp({
    command,
    cwd,
    env: process.env,
    filesystemScope,
    networkScope,
    networkAllowlist,
  });
  process.exitCode = code ?? 1;
}

if (process.argv[1] && process.argv[1].endsWith("sandbox-acp.js")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
