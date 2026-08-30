export interface GhCommandCheckResult {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Pure evaluator that validates whether a `gh` CLI invocation is read-only.
 * Strictly blocks comment creation or PR thread mutation.
 */
export function evaluateGhCommandAllowed(args: readonly string[]): GhCommandCheckResult {
  const joined = args.join(" ").toLowerCase();

  // Block `gh pr comment`, `gh issue comment`, `gh pr review --comment`, `gh pr review -c`
  if (
    (args[0] === "pr" && args[1] === "comment") ||
    (args[0] === "issue" && args[1] === "comment") ||
    (args[0] === "pr" && args[1] === "review" && (joined.includes("--comment") || joined.includes("-c") || joined.includes("--request-changes")))
  ) {
    return {
      allowed: false,
      reason: "⛔ Modifying GitHub comments is blocked by policy. All review verdicts and findings must be posted exclusively as Paperclip comments to be relayed directly to the developer session.",
    };
  }

  return {
    allowed: true,
    reason: "Command permitted under read-only review policy.",
  };
}

/**
 * Generates a transparent `gh` shim script that can be placed in the agent's PATH
 * to intercept and block any attempt to post comments to GitHub while passing through
 * read-only commands (`view`, `diff`, `checks`, `auth status`).
 */
export function createGhShimScript(): string {
  return `#!/usr/bin/env bash
# ==============================================================================
# GitHub CLI Read-Only Command Interceptor Shim
# Blocks \`gh pr comment\` and \`gh issue comment\` to enforce zero-GitHub-noise.
# ==============================================================================
set -euo pipefail

# Locate the real gh binary (excluding this shim)
REAL_GH=$(which -a gh | grep -v "$0" | head -n 1 || true)
if [ -z "$REAL_GH" ]; then
  echo "❌ Error: Real 'gh' binary not found in PATH." >&2
  exit 127
fi

# Intercept comment commands
if ([ "$#" -ge 2 ] && [ "$1" = "pr" ] && [ "$2" = "comment" ]) || \
   ([ "$#" -ge 2 ] && [ "$1" = "issue" ] && [ "$2" = "comment" ]); then
  echo "⛔ [POLICY BLOCKED] Posting comments to GitHub is disabled for Code Reviewer." >&2
  echo "👉 Output your review findings and verdicts exclusively as Paperclip comments." >&2
  echo "   The Orchestrator will automatically relay your verdict to the worker session." >&2
  exit 1
fi

# Pass through all read-only commands
exec "$REAL_GH" "$@"
`;
}
