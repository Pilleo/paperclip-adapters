import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildPrompt, hashPrompt, hashPromptIdentity, PromptContext } from '../src/server/prompt-builder';
import { AdapterConfig } from '../src/server/config';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('Prompt Builder', () => {
  const config = {
    source: 'github.com/org/repo',
    baseBranch: 'main'
  } as AdapterConfig;

  const ctx: PromptContext = {
    issueId: '123',
    runId: 'run-456',
    title: 'Fix bug',
    description: 'Fix the bug in the code',
    isRetry: false
  };

  it('builds standard prompt correctly', () => {
    const prompt = buildPrompt(ctx, config);
    expect(prompt).toContain('Task: Fix bug');
    expect(prompt).toContain('Paperclip Issue ID: 123');
    expect(prompt).toContain('[paperclip-run:run-456]');
    expect(prompt).toContain('Base Branch: main');
    expect(prompt).toContain('Instruction');
    expect(prompt).toContain('If repository changes are needed, create a pull request');
    expect(prompt).toContain('complete without a PR');
    expect(prompt).not.toContain('A previous Jules session failed');
  });

  it('builds retry prompt correctly', () => {
    const retryCtx = { ...ctx, isRetry: true, failedSessionReference: 'http://old', failedSessionMessage: 'crash' };
    const prompt = buildPrompt(retryCtx, config);
    expect(prompt).toContain('A previous Jules session failed');
    expect(prompt).toContain('Previous session: http://old');
    expect(prompt).toContain('Failure: crash');
  });

  it('generates consistent hashes', () => {
    const prompt1 = buildPrompt(ctx, config);
    const prompt2 = buildPrompt(ctx, config);

    expect(hashPrompt(prompt1)).toBe(hashPrompt(prompt2));

    const diffCtx = { ...ctx, description: 'new desc' };
    const diffPrompt = buildPrompt(diffCtx, config);
    expect(hashPrompt(prompt1)).not.toBe(hashPrompt(diffPrompt));
  });

  it('uses a stable task identity across Paperclip run ids', () => {
    expect(hashPromptIdentity(ctx, config)).toBe(
      hashPromptIdentity({ ...ctx, runId: 'run-789' }, config),
    );
    expect(hashPromptIdentity(ctx, config)).not.toBe(
      hashPromptIdentity({ ...ctx, description: 'changed task' }, config),
    );
  });
});
