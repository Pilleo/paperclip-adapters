import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { sessionCodec } from '../src/server/session';
import { JulesClient } from '../src/server/jules-client';
import { processResolvedInteraction, handleAwaitingPlanApproval } from '../src/server/interactions';
import { classifyFailure } from '../src/server/failure-classifier';
import { shouldRetry } from '../src/server/retry-policy';

vi.mock('../src/server/jules-client');
vi.mock('../src/server/interactions', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../src/server/interactions')>();
    return {
        ...mod,
        processResolvedInteraction: vi.fn((c, s, pi, ri) => mod.processResolvedInteraction(c, s, pi, ri)),
        handleAwaitingPlanApproval: vi.fn((c, s, curr) => mod.handleAwaitingPlanApproval(c, s, curr))
    };
});
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

  describe('execute extra branch coverage', () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    (JulesClient.prototype.listSessions as any).mockResolvedValue({ sessions: [] });
  });

  it('logs warning if task identity changed but not retry', async () => {
       (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ name: 'sess-1', state: 'IN_PROGRESS' });

       const sessionParams = sessionCodec.encode({
           version: 1,
           paperclipIssueId: 'task-1',
           promptHash: 'old-hash',
           promptHashVersion: 2,
           repository: 'test',
           source: 'github',
           baseBranch: 'master',
           phase: 'RUNNING',
           sessionId: 'sess-1',
           julesSessionId: 'sess-1',
           attempt: 1,
           failedSessions: [],
           createdAt: new Date().toISOString()
       } as any);

       const abortCtrl = new AbortController();
       setTimeout(() => abortCtrl.abort(), 10);

       const res = await execute({
           ...baseCtx,
           runtime: { ...baseCtx.runtime, sessionParams },
           abortSignal: abortCtrl.signal
       } as any);
       const decoded = sessionCodec.decode(res.sessionParams!);

       expect(baseCtx.onLog).toHaveBeenCalledWith('stderr', expect.stringContaining('[WARN] Task identity changed. Using original prompt hash for session sess-1'));
       expect(decoded.promptHash).toBe('old-hash'); // Remains same
  });

  it('handles early crash creation returning jules_create_failure', async () => {
        (JulesClient.prototype.createSession as any).mockRejectedValueOnce({ status: 401, message: 'Bad Auth' });
        vi.mocked(classifyFailure).mockReturnValueOnce('configuration');
        vi.mocked(shouldRetry).mockReturnValueOnce(false);

        const res = await execute({ ...baseCtx } as any);
        expect(res.exitCode).toBe(1);
        expect(res.errorCode).toBe('jules_create_failure');
        expect(res.errorFamily).toBeNull();
  });
});
