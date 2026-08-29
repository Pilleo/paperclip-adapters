import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { JulesClient, JulesClientError, extractPullRequestUrl } from '../src/server/jules-client';
import { parseJulesSessionName, asJulesSessionId } from '../src/server/brands';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('JulesClient', () => {
  let client: JulesClient;
  const apiKey = 'test-api-key';

  beforeEach(() => {
    client = new JulesClient(apiKey);
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws error if api key is missing', () => {
    expect(() => new JulesClient('')).toThrow('Jules API key is required');
  });

  it('createSession sends correct request', async () => {
    const mockResponse = { name: 'sessions/123' };
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await client.createSession({
        prompt: 'test prompt',
        sourceContext: {
            source: 'sources/test',
            githubRepoContext: { startingBranch: 'master' }
        }
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://jules.googleapis.com/v1alpha/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
        }),
        body: JSON.stringify({
            prompt: 'test prompt',
            sourceContext: {
                source: 'sources/test',
                githubRepoContext: { startingBranch: 'master' }
            }
        })
      })
    );
    expect(result.id).toEqual('123');
  });

  it('throws JulesClientError on non-ok response', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      });

    await expect(client.getSession(asJulesSessionId('invalid'))).rejects.toThrow(JulesClientError);
    await expect(client.getSession(asJulesSessionId('invalid'))).rejects.toThrow(/404/);
  });

  it('captures Retry-After without retrying a request implicitly', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? '90' : null },
      text: async () => 'Rate limited',
    });

    const error = await client.getSession(asJulesSessionId('123')).catch((caught) => caught);
    expect(error).toBeInstanceOf(JulesClientError);
    expect(error.retryAfterMs).toBe(90_000);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('getSession sends correct request', async () => {
    const mockResponse = { name: 'sessions/123', state: 'RUNNING' };
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await client.getSession(asJulesSessionId('123'));

    expect(global.fetch).toHaveBeenCalledWith(
      'https://jules.googleapis.com/v1alpha/sessions/123',
      expect.objectContaining({
        headers: expect.objectContaining({
            'X-Goog-Api-Key': apiKey,
        })
      })
    );
    expect(result.id).toEqual('123');
  });

  it('listSessions maps provider sessions and pagination', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sessions: [{
          name: 'sessions/123',
          title: 'Task',
          prompt: 'Paperclip Issue ID: issue-1',
          state: 'IN_PROGRESS',
          sourceContext: {
            source: 'sources/github/example/repo',
            githubRepoContext: { startingBranch: 'main' }
          }
        }],
        nextPageToken: 'next-token'
      }),
    });

    const result = await client.listSessions(100, 'page-token');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://jules.googleapis.com/v1alpha/sessions?pageSize=100&pageToken=page-token',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result.nextPageToken).toBe('next-token');
    expect(result.sessions[0]).toMatchObject({
      id: '123',
      source: 'sources/github/example/repo',
      baseBranch: 'main',
      state: 'IN_PROGRESS'
    });
  });

  it('sendMessage sends correct request', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await client.sendMessage(asJulesSessionId('123'), { prompt: 'hello' });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://jules.googleapis.com/v1alpha/sessions/123:sendMessage',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ prompt: 'hello' })
        })
      );
  });

  it('approvePlan sends correct request', async () => {
        (global.fetch as any).mockResolvedValueOnce({
          ok: true,
          json: async () => ({}),
        });

        await client.approvePlan(asJulesSessionId('123'));

        expect(global.fetch).toHaveBeenCalledWith(
          'https://jules.googleapis.com/v1alpha/sessions/123:approvePlan',
          expect.objectContaining({
            method: 'POST'
          })
        );
  });

  beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('extractPullRequestUrl', () => {
     it('extracts successfully', () => {
         const url = extractPullRequestUrl({
             name: parseJulesSessionName('sessions/1'),
             id: asJulesSessionId('1'),
             rawOutputs: [
                 { type: 'unrelated' },
                 { pullRequest: { url: 'http://my-pr' } }
             ]
         });
         expect(url).toBe('http://my-pr');
     });

     it('returns undefined if not found', () => {
         const url = extractPullRequestUrl({
             name: parseJulesSessionName('sessions/1'),
             id: asJulesSessionId('1'),
             rawOutputs: [
                 { type: 'unrelated' },
                 { pullRequest: { url_invalid_key: 'http://my-pr' } }
             ]
         });
         expect(url).toBeUndefined();
     });

     it('returns undefined if no outputs', () => {
          const url = extractPullRequestUrl({
              name: parseJulesSessionName('sessions/1'),
              id: asJulesSessionId('1')
          });
          expect(url).toBeUndefined();
      });
  });
});
