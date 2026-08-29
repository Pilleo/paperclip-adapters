import { createHash } from 'crypto';
import { AdapterConfig } from './config.js';

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
}

export const PROMPT_IDENTITY_HASH_VERSION = 2;

export function buildPrompt(ctx: PromptContext, config: AdapterConfig): string {
  let prompt = `Task: ${ctx.title}\n\n`;
  prompt += `Description:\n${ctx.description}\n\n`;

  prompt += `Paperclip Issue ID: ${ctx.issueId}\n`;
  prompt += `Paperclip Run Marker: [paperclip-run:${ctx.runId}]\n\n`;

  prompt += `Repository: ${config.source}\n`;
  prompt += `Base Branch: ${config.baseBranch}\n\n`;

  prompt += `Instructions:\n`;
  prompt += `- If repository changes are needed, create a pull request (PR) upon completion.\n`;
  prompt += `- If no repository changes are needed or the task explicitly requests no changes, explain the result and complete without a PR.\n`;
  prompt += `- When creating a PR, include the Paperclip Issue ID (${ctx.issueId}) in its description or title.\n`;
  prompt += `- Do not merge the PR automatically.\n`;
  prompt += `- If you are blocked or need clarification, ask a focused question.\n\n`;

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

export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

export function hashPromptIdentity(ctx: PromptContext, config: AdapterConfig): string {
  return hashPrompt(buildPrompt({ ...ctx, runId: "<paperclip-run>" }, config));
}
