import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { sessionCodec } from '../src/server/session';
import { JulesClient } from '../src/server/jules-client';
import { classifyFailure } from '../src/server/failure-classifier';
import { shouldRetry } from '../src/server/retry-policy';

vi.mock('../src/server/jules-client');
// Unit recovery evidence must not depend on an ambient authenticated gh CLI.
vi.mock('../src/server/ci-status', () => ({
    getPullRequestDetails: vi.fn().mockResolvedValue({ headSha: 'abc123' }),
    getPullRequestCiStatus: vi.fn(),
    getPullRequestPatch: vi.fn(),
    listPullRequestChangedFiles: vi.fn(),
}));
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
vi.mock('../src/server/paperclip-client', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../src/server/paperclip-client')>();
    return {
        ...mod,
        listPaperclipInteractions: vi.fn().mockResolvedValue([]),
        listIssueComments: vi.fn().mockResolvedValue([]),
        scheduleJulesSessionMonitor: vi.fn().mockResolvedValue(undefined),
        upsertJulesSessionHandle: vi.fn().mockResolvedValue(undefined),
        readJulesSessionHandleState: vi.fn().mockResolvedValue(null),
        readJulesSessionHandle: vi.fn().mockResolvedValue(null),
        createIssueComment: vi.fn().mockResolvedValue(undefined),
    };
});

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('execute retry policies', () => {
  const unexpectedFetch = vi.fn(async (url: RequestInfo | URL) => { throw new Error(`Unexpected retry-fixture network: ${String(url)}`); });
  afterEach(() => {
    vi.unstubAllGlobals();
    expect(unexpectedFetch.mock.calls.map(([url]) => String(url))).toEqual([]);
  });
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
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
      // Matching immutable PR evidence requires the pre-creation native child
      // lookup. This unit fixture has no existing reviewer children.
      if (String(url) === 'http://127.0.0.1:3100/api/companies/1/issues?limit=1000&parentId=task-1' &&
          (!options?.method || options.method === 'GET')) {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return unexpectedFetch(url);
    });
    // clearAllMocks preserves one-shot implementations. Reset the provider
    // poll mock so a heartbeat-aborted test cannot leak its queued rejection
    // into the next retry scenario.
    (JulesClient.prototype.getSession as any).mockReset();
    vi.mocked(classifyFailure).mockReset().mockReturnValue('configuration');
    vi.mocked(shouldRetry).mockReset().mockReturnValue(false);
    (JulesClient.prototype.listSessions as any).mockResolvedValue({ sessions: [] });
    (JulesClient.prototype.getActivities as any).mockResolvedValue({ activities: [] });
  });

  it('holds an ambiguous transient create failure instead of scheduling another POST', async () => {
    (JulesClient.prototype.createSession as any).mockRejectedValueOnce({ status: 500, message: 'Server error' });
    vi.mocked(classifyFailure).mockReturnValueOnce('transient');
    vi.mocked(shouldRetry).mockReturnValueOnce(true);

    const res = await execute(baseCtx);

    expect(res.exitCode).toBe(1);
    expect(res.errorCode).toBe('jules_create_outcome_unverified');
    expect(res.sessionParams).toBeDefined();

    const session = sessionCodec.decode(res.sessionParams!);
    expect(session.phase).toBe('STARTING');
    expect(session.attempt).toBe(1);
    expect(session.failedSessions.length).toBe(0);
    expect(session.providerCreateIntent?.promptSha256).toMatch(/^[a-f0-9]{64}$/);
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
     (JulesClient.prototype.getSession as any).mockResolvedValue({ state: 'COMPLETED' });
     global.fetch = vi.fn().mockImplementation(async (url: any) => {
       const urlStr = String(url);
       if (urlStr.includes("/comments")) {
         return { ok: true, status: 200, json: async () => [] };
       }
       return {
         ok: true,
         status: 201,
         json: async () => ({ id: "interaction-1", status: "pending" }),
       };
     });

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
      (JulesClient.prototype.getSession as any).mockResolvedValue({ state: 'FAILED' });
      vi.mocked(shouldRetry).mockReturnValueOnce(true); // Retry the explicitly failed session

      const abortCtrl = new AbortController();
      const res = await execute({ ...resumedCtx, abortSignal: abortCtrl.signal } as any);

      expect(res.exitCode).toBe(1);
      expect(res.errorCode).toBe('jules_transient_failure');
      const session = sessionCodec.decode(res.sessionParams!);
      expect(session.phase).toBe('RETRY_SCHEDULED');
  });

  it('handles FAILED jules state without retry (exhausted)', async () => {
        (JulesClient.prototype.getSession as any).mockResolvedValue({ state: 'FAILED' });
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

  it('creates a single remediation session on the existing PR branch after terminal failure', async () => {
      let createRequest: any;
      let creates = 0;
      const abortCtrl = new AbortController();
      (JulesClient.prototype.createSession as any).mockImplementationOnce((request: unknown) => {
        creates++;
        createRequest = request;
        // This contract ends at acknowledged recovery creation. A wall-clock
        // abort can let faster CI workers poll the deliberately FAILED fixture
        // again and enter an unrelated question/adjudication workflow.
        abortCtrl.abort();
        return Promise.resolve({ id: 'recovery-124', name: 'sessions/recovery-124' });
      });
      (JulesClient.prototype.getSession as any).mockResolvedValue({ state: 'FAILED', source: 'github' });
      const sessionParams = sessionCodec.encode({
          version: 1,
          paperclipIssueId: 'task-1',
          promptHash: 'old-hash',
          repository: 'test',
          source: 'github',
          baseBranch: 'master',
          phase: 'RETRY_SCHEDULED',
          sessionId: 'terminal-123',
          julesSessionId: 'terminal-123',
          attempt: 1,
          failedSessions: [{ sessionId: 'terminal-123', failedAt: new Date().toISOString(), message: 'provider failed', classification: 'transient', prUrl: 'https://github.com/Pilleo/paperclip-adapters/pull/11' }],
          currentPrUrl: 'https://github.com/Pilleo/paperclip-adapters/pull/11',
          currentPrHeadSha: 'abc123',
          currentPrHeadRef: 'jules-18036993849073318863-b259ffba',
          prRemediation: {
            originalSessionId: 'terminal-123',
            prUrl: 'https://github.com/Pilleo/paperclip-adapters/pull/11',
            headSha: 'abc123',
            headRefName: 'jules-18036993849073318863-b259ffba',
            startedAt: '2026-09-13T20:00:00.000Z',
          },
          createdAt: new Date().toISOString(),
      } as any);
      const result = await execute({
        ...baseCtx,
        runtime: { ...baseCtx.runtime, sessionParams },
        abortSignal: abortCtrl.signal,
      } as any);

      expect((baseCtx.onLog as any).mock.calls.flat().join("\n")).toContain("Created session recovery-124");
      expect(creates).toBe(1);
      expect(createRequest).toMatchObject({
        sourceContext: { githubRepoContext: { startingBranch: 'jules-18036993849073318863-b259ffba' } },
      });
      expect(sessionCodec.decode(result.sessionParams!)?.currentPrUrl).toBe('https://github.com/Pilleo/paperclip-adapters/pull/11');
      expect(sessionCodec.decode(result.sessionParams!)?.prRemediation).toMatchObject({
        recoverySessionId: 'recovery-124',
        headRefName: 'jules-18036993849073318863-b259ffba',
      });
  });
});
