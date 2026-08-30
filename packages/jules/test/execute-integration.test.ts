import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { sessionCodec } from '../src/server/session';
import { JulesClient } from '../src/server/jules-client';

vi.mock('../src/server/jules-client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/server/jules-client')>();
  const MockedJulesClient = vi.fn();
  MockedJulesClient.prototype.createSession = vi.fn();
  MockedJulesClient.prototype.listSessions = vi.fn().mockResolvedValue({ sessions: [] });
  MockedJulesClient.prototype.getSession = vi.fn();
  MockedJulesClient.prototype.getActivities = vi.fn().mockResolvedValue({ activities: [] });
  return {
    ...mod,
    JulesClient: MockedJulesClient
  };
});

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('Full Paperclip Continuation Lifecycle Integration', () => {
    const baseCtx: AdapterExecutionContext = {
        agent: {
            id: '1', companyId: '1', name: 'agent', adapterType: 'jules',
            adapterConfig: {
              source: 'github', repository: 'test', baseBranch: 'master', pollIntervalSeconds: 10, heartbeatPollWindowSeconds: 30,
              ciPolicy: 'skip',
            }
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: 'task-1' },
        config: { env: { JULES_API_KEY: 'test-key' } },
        context: {

        task: { id: 'task-1', title: 'Task' }
        },
        runId: 'run-1',
        abortSignal: new AbortController().signal,
        onLog: vi.fn()
    } as any;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('Lifecycle: Multi-heartbeat Continuation Integration', async () => {
        let step = 1;
        let createdCount = 0;
        (JulesClient.prototype.createSession as any).mockImplementation(() => {
            createdCount++;
            return Promise.resolve({ id: '123', name: 'sessions/123' });
        });
        (JulesClient.prototype.getSession as any).mockImplementation(() => {
           if (step === 1) return Promise.resolve({ id: '123', name: 'sessions/123', state: 'QUEUED' });
           if (step === 2) return Promise.resolve({ id: '123', name: 'sessions/123', state: 'IN_PROGRESS' });
           if (step === 3) return Promise.resolve({
               id: '123',
               name: 'sessions/123',
               state: 'COMPLETED',
               rawOutputs: [{ pullRequest: { url: 'https://pr' } }]
           });
        });

        const abortCtrl1 = new AbortController();
        setTimeout(() => abortCtrl1.abort(), 10);

        let res = await execute({ ...baseCtx, abortSignal: abortCtrl1.signal } as any);
        expect(res.exitCode).toBe(0);
        // pending checkpoint has exitCode 0
        let session = sessionCodec.decode(res.sessionParams!);
        expect(session.julesSessionId).toBe('123');
        expect(session.phase).toBe('RUNNING');
        expect(createdCount).toBe(1);

        // Heartbeat 2: Host retains session Params, we resume safely
        step = 2;

        const abortCtrl2 = new AbortController();
        setTimeout(() => abortCtrl2.abort(), 10);

        res = await execute({
            ...baseCtx,
            runtime: { ...baseCtx.runtime, sessionParams: res.sessionParams },
            abortSignal: abortCtrl2.signal
        } as any);

        expect(res.exitCode).toBe(0);
        // pending checkpoint has exitCode 0
        session = sessionCodec.decode(res.sessionParams!);
        expect(session.julesSessionId).toBe('123');
        expect(session.phase).toBe('RUNNING');
        expect(createdCount).toBe(1);

        // Paperclip normalizes external-adapter resume state to canonical
        // sessionId-only parameters before a later heartbeat.
        step = 2;
        const canonicalResume = { sessionId: '123' };
        const abortCtrlCanonical = new AbortController();
        setTimeout(() => abortCtrlCanonical.abort(), 10);

        res = await execute({
            ...baseCtx,
            runtime: { ...baseCtx.runtime, sessionParams: canonicalResume },
            abortSignal: abortCtrlCanonical.signal
        } as any);

        session = sessionCodec.decode(res.sessionParams!);
        expect(session.julesSessionId).toBe('123');
        expect(res.exitCode).toBe(0);
        // pending checkpoint has exitCode 0
        expect(createdCount).toBe(1);

        // Heartbeat 3: Completes and blocks requiring PR review
        step = 3;

        const abortCtrl3 = new AbortController();
        setTimeout(() => abortCtrl3.abort(), 10);

        const ctx3 = {
            ...baseCtx,
            runtime: { ...baseCtx.runtime, sessionParams: res.sessionParams },
            abortSignal: abortCtrl3.signal,
            authToken: 'jwt-token'
        } as any;
        global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        res = await execute(ctx3);

        expect(res.exitCode).toBe(0);
        expect(res.summary || "").toContain('moved the Paperclip issue to review');
        expect(res.clearSession).toBe(false);
        expect(createdCount).toBe(1);
    });

});
