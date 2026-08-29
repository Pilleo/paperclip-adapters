import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { JulesActivitiesResponseSchema, JulesClient } from '../src/server/jules-client';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('JulesClient Zod Validation', () => {
    it('getSession throws Zod error if name is missing', async () => {
       const client = new JulesClient('test');
       global.fetch = vi.fn().mockResolvedValueOnce({
          ok: true,
          json: async () => ({ state: 'RUNNING' })
       });

       await expect(client.getSession('id' as any)).rejects.toThrow(/Required/);
    });

    it('createSession sends correct shape based on Jules API schema', async () => {
       const client = new JulesClient('test');
       global.fetch = vi.fn().mockResolvedValueOnce({
          ok: true,
          json: async () => ({ name: 'sess-1' })
       });

       await client.createSession({
           prompt: 'test',
           title: 't',
           sourceContext: {
               source: 'sources/github',
               githubRepoContext: { startingBranch: 'main' }
           }
       });

       expect(global.fetch).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
              body: expect.stringContaining('"sourceContext":{"source":"sources/github","githubRepoContext":{"startingBranch":"main"}}')
          })
       );
    });

    it('accepts a live plan step without an index', () => {
      const parsed = JulesActivitiesResponseSchema.parse({
        activities: [{
          id: 'activity-1',
          planGenerated: {
            plan: {
              id: 'plan-1',
              steps: [{ id: 'step-1', title: 'Inspect repository' }],
            },
          },
        }],
      });

      expect(parsed.activities?.[0]?.planGenerated?.plan.steps[0]?.index).toBeUndefined();
    });
});
