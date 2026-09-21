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
    repository: 'org/repo',
    baseBranch: 'main'
  } as AdapterConfig;

  const ctx: PromptContext = {
    issueId: '123',
    runId: 'run-456',
    title: 'Fix bug',
    description: 'Fix the bug in the code',
    isRetry: false
  };

  it('renders structured frontmatter as concise scope hints instead of a synthetic plan', () => {
    const prompt = buildPrompt(
      {
        ...ctx,
        description: `---
title: "Cap cache"
target_files: ["enforcer/src/main/kotlin/io/mazewall/enforcer/SandboxDispatcher.kt"]
target_symbols: ["SandboxDispatcher#getOrCreate"]
---
**Needed:** Bound the cache.
`,
      },
      config,
    );
    expect(prompt).toContain('Scope hints:');
    expect(prompt).toContain('SandboxDispatcher.kt');
    expect(prompt).toContain('SandboxDispatcher#getOrCreate');
    expect(prompt).not.toContain('Implementation plan');
    expect(prompt).not.toContain('No explicit context specified.');
  });

  it('keeps an unstructured task literal and omits fabricated scope boilerplate', () => {
    const prompt = buildPrompt({
      ...ctx,
      title: 'Canary A: implement increment',
      description: 'orchestrator_managed: true component: "core" target_files: ["canary-increment.js"]\n\nImplement the increment helper and its focused behavioral test.',
    }, config);

    expect(prompt).toContain('Task: Canary A: implement increment');
    expect(prompt).toContain('Implement the increment helper and its focused behavioral test.');
    expect(prompt).toContain('Repository: org/repo');
    expect(prompt).toContain('Implement the task and relevant tests; run the relevant tests; commit and create or update a PR. Do not merge it.');
    expect(prompt).not.toContain('Implementation plan');
    expect(prompt).not.toContain('scope contract');
    expect(prompt).not.toContain('Target Files:');
    expect(prompt).not.toContain('No explicit context specified.');
    expect(prompt).not.toContain('Implement the fix or feature according to requirements.');
    expect(prompt).not.toContain('Do not add files or scope outside it without asking.');
  });

  it('builds standard prompt correctly', () => {
    const prompt = buildPrompt(ctx, config);
    expect(prompt).toContain('Task: Fix bug');
    expect(prompt).toContain('Paperclip Issue ID: 123');
    expect(prompt).toContain('[paperclip-run:run-456]');
    expect(prompt).toContain('Base Branch: main');
    expect(prompt).toContain('Workflow:');
    expect(prompt).toContain('Implement the task and relevant tests; run the relevant tests; commit and create or update a PR. Do not merge it.');
    expect(prompt).not.toContain('scope contract');
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

  it('does not expose backlog sync identity metadata to Jules', () => {
    const prompt = buildPrompt({
      ...ctx,
      description: `---\npaperclip_issue_id: old-issue\npaperclip_identifier: MAZ-823\ntitle: "Fix bug"\n---\nKeep this requirement.`,
    }, config);
    expect(prompt).not.toContain('old-issue');
    expect(prompt).not.toContain('MAZ-823');
    expect(prompt).toContain('Keep this requirement.');
  });
});
