import { describe, expect, it } from 'vitest';
import { CtxContextSchema } from '../src/server/context-schemas.js';

describe('CtxContextSchema', () => {
  it('accepts the current Paperclip issue context shape', () => {
    const context = CtxContextSchema.parse({
      paperclipIssue: { id: 'issue-1', title: 'Test issue', description: 'Details' }
    });

    expect(context.task).toEqual({ id: 'issue-1', title: 'Test issue', description: 'Details' });
  });

  it('retains support for the legacy task context shape', () => {
    const context = CtxContextSchema.parse({ task: { id: 'issue-1', title: 'Test issue' } });

    expect(context.task).toEqual({ id: 'issue-1', title: 'Test issue', description: '' });
  });
});
