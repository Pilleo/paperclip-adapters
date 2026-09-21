import { createHash } from 'crypto';
import { AdapterConfig } from './config.js';
import { parseTaskContract, stripPaperclipIdentityMetadata } from '@pilleo/paperclip-adapter-common';

export interface PromptContext {
  issueId: string;
  runId: string;
  title: string;
  description: string;
  isRetry: boolean;
  /** How many times this task has been retried (1 = first retry, 0 = fresh). */
  resumeAttempt?: number | undefined;
  failedSessionReference?: string | undefined;
  failedSessionMessage?: string | undefined;
  /** PR URLs from prior sessions that may have partial work. */
  priorPrUrls?: string[] | undefined;
  workspacePath?: string | undefined;
}

export const PROMPT_IDENTITY_HASH_VERSION = 3;

export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

export function buildPrompt(ctx: PromptContext, config: AdapterConfig): string {
  const taskDescription = stripPaperclipIdentityMetadata(ctx.description);
  const contract = parseTaskContract(taskDescription);
  const repository = config.repository || config.source;
  const lines = [
    `Task: ${ctx.title}`,
    "",
    "Requirements:",
    contract.requirements,
    "",
  ];

  if (contract.kind === "structured") {
    lines.push("Scope hints:", ...contract.targetFiles.map((file) => `- ${file}`));
    if (contract.targetSymbols.length > 0) lines.push(...contract.targetSymbols.map((symbol) => `- ${symbol}`));
    lines.push("");
  }

  lines.push(
    `Repository: ${repository}`,
    `Base Branch: ${config.baseBranch}`,
    "",
    "Workflow:",
    "Implement the task and relevant tests; run the relevant tests; commit and create or update a PR. Do not merge it.",
    "Ask a focused question only for a concrete ambiguity or blocker.",
    "",
    `Paperclip Issue ID: ${ctx.issueId}; Run Marker: [paperclip-run:${ctx.runId}]`,
    "",
  );
  let prompt = lines.join("\n");

  if (ctx.isRetry) {
    if (ctx.resumeAttempt && ctx.resumeAttempt > 1) {
      // Continuation: prior sessions may have pushed partial work or left branches.
      prompt += `This is a CONTINUATION of a multi-session task.\n`;
      prompt += `IMPORTANT: your pull request MUST target base branch "${config.baseBranch}".\n`;
      prompt += `Do NOT create a PR against any other branch, even if one exists from a previous session.\n`;
      if (ctx.priorPrUrls?.length) {
        prompt += `Prior attempts produced these PRs (review them for context, do not build on their branches):\n`;
        for (const url of ctx.priorPrUrls) prompt += `  - ${url}\n`;
        prompt += `\n`;
      }
      prompt += `Start from the tip of "${config.baseBranch}". Review what exists before writing code.\n`;
      prompt += `Do not redo completed work - verify it, then continue from where the last session stopped.\n\n`;
    } else {
      prompt += `A previous Jules session failed unexpectedly.\n`;
      prompt += `Previous session: ${ctx.failedSessionReference || 'Unknown'}\n`;
      prompt += `Failure: ${ctx.failedSessionMessage || 'Unknown error'}\n\n`;
      prompt += `Start cleanly from the current base branch. Do not assume the previous session's workspace exists. Preserve the original task and acceptance criteria.\n`;
    }
  }

  return prompt;
}

export function hashPromptIdentity(
  contextOrIssueId: PromptContext | string,
  configOrTitle: AdapterConfig | string,
  description?: string,
  source?: string,
  baseBranch?: string
): string {
  if (typeof contextOrIssueId === 'object') {
    const ctx = contextOrIssueId;
    const cfg = configOrTitle as AdapterConfig;
    return createHash('sha256')
      .update(`${PROMPT_IDENTITY_HASH_VERSION}:${ctx.issueId}:${ctx.title}:${stripPaperclipIdentityMetadata(ctx.description)}:${cfg.source}:${cfg.baseBranch}`)
      .digest('hex');
  }

  return createHash('sha256')
    .update(`${PROMPT_IDENTITY_HASH_VERSION}:${contextOrIssueId}:${configOrTitle}:${stripPaperclipIdentityMetadata(description || '')}:${source || ''}:${baseBranch || ''}`)
    .digest('hex');
}
