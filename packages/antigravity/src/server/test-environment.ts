import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { AntigravityConfigSchema } from "./config.js";

async function fileExistsAndExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const parsed = AntigravityConfigSchema.safeParse(ctx.config ?? {});
  const config = parsed.success ? parsed.data : AntigravityConfigSchema.parse({});

  // 1. Check binary existence and executable permissions
  const serverPath = path.resolve(config.serverPath);
  const binaryOk = await fileExistsAndExecutable(serverPath);

  if (binaryOk) {
    checks.push({
      code: "agy_server_executable",
      level: "info",
      message: `Antigravity ACP server is accessible and executable at: ${serverPath}`,
      detail: null,
      hint: null,
    });
  } else {
    checks.push({
      code: "agy_server_missing_or_not_executable",
      level: "error",
      message: `Antigravity ACP server binary was not found or lacks execute permissions: ${serverPath}`,
      detail: null,
      hint: "Ensure the path in serverPath is correct and `chmod +x` is set.",
    });
  }

  // 2. Check working directory
  const cwd = config.cwd ? path.resolve(config.cwd) : process.cwd();
  try {
    const stats = await fs.stat(cwd);
    if (stats.isDirectory()) {
      checks.push({
        code: "agy_cwd_valid",
        level: "info",
        message: `Working directory is valid: ${cwd}`,
        detail: null,
        hint: null,
      });
    } else {
      checks.push({
        code: "agy_cwd_not_dir",
        level: "error",
        message: `Working directory is not a directory: ${cwd}`,
        detail: null,
        hint: null,
      });
    }
  } catch (err) {
    checks.push({
      code: "agy_cwd_inaccessible",
      level: "error",
      message: `Working directory does not exist or is inaccessible: ${cwd}`,
      detail: err instanceof Error ? err.message : String(err),
      hint: null,
    });
  }

  // 3. Permission mode check
  checks.push({
    code: "agy_permission_mode",
    level: "info",
    message: `ACP permission mode configured as: ${config.permissionMode}`,
    detail: config.permissionMode === "approve-all" ? "Headless tool execution enabled without prompting." : null,
    hint: null,
  });

  const hasError = checks.some((c) => c.level === "error");
  const hasWarn = checks.some((c) => c.level === "warn");

  return {
    adapterType: ctx.adapterType,
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
