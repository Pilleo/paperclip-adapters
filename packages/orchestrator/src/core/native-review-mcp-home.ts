import fs from "node:fs/promises";
import path from "node:path";

export type NativeReviewWorkerKey = "luna_reviewer" | "terra_reviewer" | "terra_adjudicator";

/**
 * Select the dedicated MCP home for an operator-initiated card recovery.
 *
 * Historical recoveries predated Terra and implicitly used Luna's home. That
 * mixes a Terra run with Luna's transport context, so a recovery must accept
 * an explicit supported role. The Luna default preserves the documented
 * single-reviewer invocation for existing operators.
 */
export function resolveNativeReviewRecoveryWorkerKey(value?: string): NativeReviewWorkerKey {
  const key = value?.trim() || "luna_reviewer";
  switch (key) {
    case "luna_reviewer":
      return "luna_reviewer";
    case "terra_reviewer":
      return "terra_reviewer";
    case "terra_adjudicator":
      return "terra_adjudicator";
    default:
      throw new Error("PAPERCLIP_WORKER_KEY must be luna_reviewer, terra_reviewer, or terra_adjudicator");
  }
}

export interface NativeReviewRuntimeContext {
  readonly apiBase: string;
  /**
   * A reviewer home is shared by all runs for one worker. It must contain only
   * stable identity; task, interaction, and run identity are resolved from
   * Paperclip for the active invocation.
   */
  readonly companyId: string;
  readonly agentId: string;
  /** Exact card scope, when provisioning is for one review wake. */
  readonly issueId?: string;
  readonly interactionId?: string;
}

/**
 * Paperclip's stock Codex adapter may rewrite config.toml after the
 * orchestrator provisions it, which can strip MCP-specific env entries.
 * Keep the non-secret review identity in this dedicated reviewer home as a
 * compatibility fallback. It deliberately contains neither a bearer token nor
 * an item id; the bridge still resolves and validates the addressed card from
 * Paperclip at submission time. Issue/card scope is safe to persist because
 * the server still requires exactly one pending card addressed to this agent.
 */
export const NATIVE_REVIEW_RUNTIME_CONTEXT_FILE = "paperclip-native-review-runtime.json";

export function nativeReviewRuntimeContextPath(home: string): string {
  return path.join(home, NATIVE_REVIEW_RUNTIME_CONTEXT_FILE);
}

/**
 * A dedicated external CODEX_HOME avoids Paperclip's normal seed step, which
 * intentionally replaces config.toml from the user's shared home on every
 * run. The directory contains no credentials: provisioning creates only a
 * symlink to the existing auth file and this managed MCP configuration.
 */
export function resolveNativeReviewMcpHome(input: {
  readonly instanceRoot: string;
  readonly companyId: string;
  readonly workerKey: NativeReviewWorkerKey;
}): string {
  return path.join(input.instanceRoot, "companies", input.companyId, "native-review-mcp", input.workerKey);
}

export function nativeReviewMcpConfigToml(input: {
  readonly nodePath: string;
  readonly serverPath: string;
  readonly runtimeContext: NativeReviewRuntimeContext;
}): string {
  return [
    "# Managed by paperclip-orchestrator. This home exposes exactly one typed review tool.",
    "# It deliberately contains no Paperclip credential; the MCP process receives the run-scoped bridge at launch.",
    "[shell_environment_policy]",
    'inherit = "all"',
    "",
    "[mcp_servers.paperclip_review]",
    `command = ${JSON.stringify(input.nodePath)}`,
    `args = [${JSON.stringify(input.serverPath)}]`,
    "",
    "[mcp_servers.paperclip_review.env]",
    `PAPERCLIP_API_URL = ${JSON.stringify(input.runtimeContext.apiBase)}`,
    `PAPERCLIP_COMPANY_ID = ${JSON.stringify(input.runtimeContext.companyId)}`,
    `PAPERCLIP_AGENT_ID = ${JSON.stringify(input.runtimeContext.agentId)}`,
    "",
  ].join("\n");
}

/**
 * Provision the self-contained reviewer home used by the stock codex-local
 * adapter. `auth.json` remains a symlink to the already-managed Codex login;
 * this code never reads, serializes, or copies its content.
 */
export async function provisionNativeReviewMcpHome(input: {
  readonly home: string;
  readonly authSource: string;
  readonly nodePath: string;
  readonly serverPath: string;
  readonly runtimeContext: NativeReviewRuntimeContext;
}): Promise<void> {
  await fs.access(input.authSource);
  await fs.mkdir(input.home, { recursive: true, mode: 0o700 });
  await fs.chmod(input.home, 0o700);
  await fs.writeFile(
    path.join(input.home, "config.toml"),
    nativeReviewMcpConfigToml({
      nodePath: input.nodePath,
      serverPath: input.serverPath,
      runtimeContext: input.runtimeContext,
    }),
    { mode: 0o600 },
  );
  await fs.chmod(path.join(input.home, "config.toml"), 0o600);
  await fs.writeFile(
    nativeReviewRuntimeContextPath(input.home),
    `${JSON.stringify(input.runtimeContext)}\n`,
    { mode: 0o600 },
  );
  await fs.chmod(nativeReviewRuntimeContextPath(input.home), 0o600);
  const link = path.join(input.home, "auth.json");
  await fs.rm(link, { force: true });
  await fs.symlink(input.authSource, link);
}
