import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { VibeConfigSchema } from "./config.js";

const execFileAsync = promisify(execFile);

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const parsed = VibeConfigSchema.safeParse(ctx.config ?? {});
  const config = parsed.success ? parsed.data : VibeConfigSchema.parse({});

  // 1. Check vibe --acp in PATH
  try {
    const { stdout } = await execFileAsync("which", [config.serverCommand]);
    checks.push({
      code: "vibe_binary_found",
      level: "info",
      message: `Mistral Vibe ACP binary located at: ${stdout.trim()}`,
      detail: null,
      hint: null,
    });
  } catch {
    checks.push({
      code: "vibe_binary_missing",
      level: "error",
      message: `Mistral Vibe ACP executable '${config.serverCommand}' was not found in PATH`,
      detail: null,
      hint: "Ensure vibe --acp is installed and present in PATH.",
    });
  }

  // 2. Check working directory
  const cwd = config.cwd ? path.resolve(config.cwd) : process.cwd();
  try {
    const stats = await fs.stat(cwd);
    if (stats.isDirectory()) {
      checks.push({
        code: "vibe_cwd_valid",
        level: "info",
        message: `Working directory is valid: ${cwd}`,
        detail: null,
        hint: null,
      });
    } else {
      checks.push({
        code: "vibe_cwd_not_dir",
        level: "error",
        message: `Working directory is not a directory: ${cwd}`,
        detail: null,
        hint: null,
      });
    }
  } catch (err) {
    checks.push({
      code: "vibe_cwd_inaccessible",
      level: "error",
      message: `Working directory is inaccessible: ${cwd}`,
      detail: err instanceof Error ? err.message : String(err),
      hint: null,
    });
  }

  const hasError = checks.some((c) => c.level === "error");
  const hasWarn = checks.some((c) => c.level === "warn");

  return {
    adapterType: ctx.adapterType,
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
