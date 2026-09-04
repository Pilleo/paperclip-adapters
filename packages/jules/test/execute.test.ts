import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { JulesClient } from '../src/server/jules-client';
import { sessionCodec } from '../src/server/session';

vi.mock('../src/server/jules-client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/server/jules-client')>();
  const MockedJulesClient = vi.fn();
  MockedJulesClient.prototype.createSession = vi.fn().mockResolvedValue({ id: '123', name: 'sessions/123' });
  MockedJulesClient.prototype.listSessions = vi.fn().mockResolvedValue({ sessions: [] });
  MockedJulesClient.prototype.getSession = vi.fn().mockResolvedValue({ state: 'IN_PROGRESS' });
  MockedJulesClient.prototype.getActivities = vi.fn().mockResolvedValue({ activities: [] });
  MockedJulesClient.prototype.sendMessage = vi.fn();
  MockedJulesClient.prototype.approvePlan = vi.fn();
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

  describe('execute', () => {
  const baseCtx: AdapterExecutionContext = {
    agent: {
        id: '1', companyId: '1', name: 'agent', adapterType: 'jules',
        adapterConfig: {
          source: 'github',
          repository: 'pilleo/test',
          baseBranch: 'master',
          pollIntervalSeconds: 10,
          heartbeatPollWindowSeconds: 30
        }
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: 'task-1' },
    config: { env: { JULES_API_KEY: 'test-key' } },
    context: {

        task: { id: 'task-1', title: 'Test Task', description: 'Test desc' }
    },
    runId: 'run-1',
    abortSignal: new AbortController().signal,
    onLog: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checkpoints a new session as pending before long polling', async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    const before = Date.now();
    const res = await execute({ ...baseCtx, abortSignal: abortCtrl.signal } as any);
    expect(res.exitCode).toBe(0);
    // pending checkpoint has no error code
    // pending checkpoint has no error family
    expect(res.clearSession).toBe(false);
    expect(res.sessionParams).toBeDefined();
    expect(new Date(res.retryNotBefore!).getTime()).toBeGreaterThanOrEqual(before + 5 * 1000);
    expect(new Date(res.retryNotBefore!).getTime()).toBeLessThan(before + 60 * 1000);

    const session = sessionCodec.decode(res.sessionParams!);
    expect(session.sessionId).toBe('123');
    expect(session.julesSessionId).toBe('123');
    expect(session.phase).toBe('RUNNING');
    expect(res.summary).toContain('Jules session 123 is RUNNING');
    expect(res.summary).toContain('resume polling');
  });

  it('moves the issue to review on COMPLETED state with PR', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    (JulesClient.prototype.getSession as any).mockResolvedValueOnce({
        state: 'COMPLETED',
        rawOutputs: [{ pullRequest: { url: 'http://pr/1' } }]
    });

    const checkpoint = await execute({
      ...baseCtx,
      agent: {
        ...baseCtx.agent,
        adapterConfig: { ...baseCtx.agent.adapterConfig, ciPolicy: "skip" }
      }
    } as any);
    console.log("CHECKPOINT RES:", checkpoint.exitCode, checkpoint.errorCode, checkpoint.errorMessage, checkpoint.summary);
    const res = await execute({
      ...baseCtx,
      agent: {
        ...baseCtx.agent,
        adapterConfig: { ...baseCtx.agent.adapterConfig, ciPolicy: "skip" }
      },
      runtime: { ...baseCtx.runtime, sessionParams: checkpoint.sessionParams },
      authToken: 'jwt-token',
    } as any);
    if (res.exitCode !== 0) console.log("RES DETAILS:", res.exitCode, res.errorCode, res.errorMessage, res.summary);
    expect(res.exitCode).toBe(0);
    expect(res.clearSession).toBe(true);
    expect(res.resultJson?.prUrl).toBe('http://pr/1');
    expect(res.resultJson?.issueStatus).toBe('in_review');
  });

  it('creates a Paperclip feedback interaction when Jules awaits feedback', async () => {
    (JulesClient.prototype.getSession as any).mockResolvedValue({ state: 'AWAITING_USER_FEEDBACK' });
    global.fetch = vi.fn().mockImplementation(async (url, init) => {
      const method = init?.method || "GET";
      if (String(url).includes("/interactions") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: "feedback-1", status: "pending", kind: "ask_user_questions" }],
        };
      }
      if (String(url).includes("/interactions") && method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "feedback-1", status: "pending", kind: "ask_user_questions" }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const checkpoint = await execute(baseCtx);
    const res = await execute({
      ...baseCtx,
      runtime: { ...baseCtx.runtime, sessionParams: checkpoint.sessionParams },
      authToken: 'jwt-token',
    } as any);
    expect(res.exitCode).toBe(0);
    expect(res.resultJson?.issueStatus).toBe('in_progress');
    expect(res.resultJson?.interactionId).toBe('feedback-1');
    expect(res.question).toBeUndefined();
    expect(sessionCodec.decode(res.sessionParams!).pendingInteraction).toMatchObject({
      type: 'user_feedback',
      paperclipInteractionId: 'feedback-1',
    });
  });
});
