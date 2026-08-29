import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { sessionCodec } from '../src/server/session';
import { JulesClient } from '../src/server/jules-client';
import { classifyFailure } from '../src/server/failure-classifier';
import { shouldRetry } from '../src/server/retry-policy';

vi.mock('../src/server/jules-client');
vi.mock('../src/server/failure-classifier', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../src/server/failure-classifier')>();
    return {
        ...mod,
        classifyFailure: vi.fn((err) => mod.classifyFailure(err))
    };
});
vi.mock('../src/server/retry-policy', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../src/server/retry-policy')>();
    return {
        ...mod,
        shouldRetry: vi.fn((c, a, config) => mod.shouldRetry(c, a, config))
    };
});

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('execute retry policies', () => {
  const baseCtx: AdapterExecutionContext = {
    agent: {
        id: '1', companyId: '1', name: 'agent', adapterType: 'jules',
        adapterConfig: {
          source: 'github', repository: 'test', baseBranch: 'master', pollIntervalSeconds: 10, heartbeatPollWindowSeconds: 30
        }
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: 'task-1' },
    config: { env: { JULES_API_KEY: 'test-key' } },
    context: {

        task: { id: 'task-1', title: 'Task' }
    },
    runId: 'run-1',
    abortSignal: new AbortController().signal,
    resolvedInteractions: [],
    onLog: vi.fn()
  } as any;

  const activeSessionParams = sessionCodec.encode({
      version: 1,
      paperclipIssueId: 'task-1',
      promptHash: 'active-hash',
      repository: 'test',
      source: 'github',
      baseBranch: 'master',
      phase: 'RUNNING',
      sessionId: '123',
      julesSessionId: '123',
      attempt: 1,
      failedSessions: [],
      createdAt: new Date().toISOString()
  } as any);

  const resumedCtx = {
      ...baseCtx,
      runtime: { ...baseCtx.runtime, sessionParams: activeSessionParams }
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    (JulesClient.prototype.listSessions as any).mockResolvedValue({ sessions: [] });
    (JulesClient.prototype.getActivities as any).mockResolvedValue({ activities: [] });
  });

  it('handles create session failure (transient) and returns RETRY_SCHEDULED', async () => {
    (JulesClient.prototype.createSession as any).mockRejectedValueOnce({ status: 500, message: 'Server error' });
    vi.mocked(classifyFailure).mockReturnValueOnce('transient');
    vi.mocked(shouldRetry).mockReturnValueOnce(true);

    const res = await execute(baseCtx);

    expect(res.exitCode).toBe(1);
    expect(res.errorCode).toBe('jules_transient_failure');
    expect(res.sessionParams).toBeDefined();

    const session = sessionCodec.decode(res.sessionParams!);
    expect(session.phase).toBe('RETRY_SCHEDULED');
    expect(session.attempt).toBe(1);
    expect(session.failedSessions.length).toBe(1);
  });

  it('handles polling failure (transient) within heartbeat and loop limits', async () => {
    (JulesClient.prototype.getSession as any).mockRejectedValueOnce({ status: 500, message: 'Poll failed' });
    vi.mocked(classifyFailure).mockReturnValueOnce('transient');

    const abortCtrl = new AbortController();
    setTimeout(() => abortCtrl.abort(), 10);

    const res = await execute({ ...resumedCtx, abortSignal: abortCtrl.signal } as any);
    expect(res.exitCode).toBe(0);
    // pending checkpoint has exitCode 0
    const session = sessionCodec.decode(res.sessionParams!);
    expect(session.sessionId).toBe('123');
    expect(session.julesSessionId).toBe('123');
  });

  it('handles polling failure (fatal)', async () => {
    (JulesClient.prototype.getSession as any).mockRejectedValueOnce({ status: 401, message: 'Auth error' });
    vi.mocked(classifyFailure).mockReturnValueOnce('configuration');

    const abortCtrl = new AbortController();

    const res = await execute({ ...resumedCtx, abortSignal: abortCtrl.signal } as any);
    expect(res.exitCode).toBe(1);
    expect(res.errorCode).toBe('jules_polling_error');
  });

  it('handles COMPLETED state with false success (no PR)', async () => {
     (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'COMPLETED' });
     global.fetch = vi.fn()
       .mockResolvedValueOnce({
         ok: true,
         status: 201,
         json: async () => ({ id: 'interaction-1', status: 'pending' }),
       })
       .mockResolvedValueOnce({ ok: true, status: 200 });

     const res = await execute({ ...resumedCtx, authToken: 'jwt-token' });
     expect(res.exitCode).toBe(0);
     expect(res.question).toBeUndefined();
     expect(res.resultJson?.issueStatus).toBe('blocked');
     expect(sessionCodec.decode(res.sessionParams!)?.pendingInteraction).toMatchObject({
       type: 'completion_confirmation',
       paperclipInteractionId: 'interaction-1',
     });
  });

  it('handles FAILED jules state with retry', async () => {
      (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'FAILED' });
      vi.mocked(shouldRetry).mockReturnValueOnce(true); // Retry the explicitly failed session

      const abortCtrl = new AbortController();
      const res = await execute({ ...resumedCtx, abortSignal: abortCtrl.signal } as any);

      expect(res.exitCode).toBe(1);
      expect(res.errorCode).toBe('jules_transient_failure');
      const session = sessionCodec.decode(res.sessionParams!);
      expect(session.phase).toBe('RETRY_SCHEDULED');
  });

  it('handles FAILED jules state without retry (exhausted)', async () => {
        (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'FAILED' });
        vi.mocked(shouldRetry).mockReturnValueOnce(false);

        const res = await execute(resumedCtx);

        expect(res.exitCode).toBe(1);
        expect(res.errorCode).toBe('jules_task_failure');
        expect(res.clearSession).toBe(false);
  });

  it('resumes from RETRY_SCHEDULED by creating new session', async () => {
      let created = false;
      (JulesClient.prototype.createSession as any).mockImplementationOnce(() => {
         created = true;
         return Promise.resolve({ id: '124', name: 'sessions/124' });
      });
      (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'IN_PROGRESS' });

      const sessionParams = sessionCodec.encode({
          version: 1,
          paperclipIssueId: 'task-1',
          promptHash: 'old-hash',
          repository: 'test',
          source: 'github',
          baseBranch: 'master',
          phase: 'RETRY_SCHEDULED',
          attempt: 1,
          failedSessions: [{ sessionId: 'sess-1', failedAt: new Date().toISOString(), message: 'failed', classification: 'transient' }],
          createdAt: new Date().toISOString()
      } as any);

      const abortCtrl = new AbortController();
      setTimeout(() => abortCtrl.abort(), 10);

      const ctx = {
          ...baseCtx,
          runtime: { ...baseCtx.runtime, sessionParams },
          abortSignal: abortCtrl.signal
      } as any;
      const res = await execute(ctx);

      expect(created).toBe(true);
      const newSession = sessionCodec.decode(res.sessionParams!);
      expect(newSession.sessionId).toBe('124');
      expect(newSession.julesSessionId).toBe('124');
  });
});
