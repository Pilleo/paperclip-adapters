import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { JulesActivitySchema, JulesClient, JulesClientError } from '../src/server/jules-client';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('JulesClient Extra', () => {
  it('throws Unknown error if text parsing fails', async () => {
    const client = new JulesClient('test-key');
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('Parse fail')),
    });

    await expect(client.getSession('id')).rejects.toThrow('Jules API error (500): Unknown error');
  });

  it('returns null on 204 No Content', async () => {
    const client = new JulesClient('test-key');
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 204,
    });

    const res = await client.approvePlan('id');
    expect(res).toBeNull();
  });

  it('gets activities from the session collection endpoint', async () => {
      const client = new JulesClient('test-key');
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await client.getActivities('sess-1', 'page-123');
      expect(global.fetch).toHaveBeenCalledWith(
          'https://jules.googleapis.com/v1alpha/sessions/sess-1/activities?pageSize=100&pageToken=page-123',
          expect.anything()
      );
  });

  it('accepts a Jules progress activity without a description', () => {
    expect(JulesActivitySchema.parse({
      id: 'activity-1',
      progressUpdated: { title: 'Working' },
    }).progressUpdated).toEqual({ title: 'Working' });
  });
});
