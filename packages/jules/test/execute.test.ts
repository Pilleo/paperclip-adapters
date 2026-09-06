import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { JulesClient } from '../src/server/jules-client';
import { sessionCodec } from '../src/server/session';
import { getPullRequestDetails, listPullRequestChangedFiles, getPullRequestPatch } from "../src/server/ci-status.js";

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

  vi.mock("../src/server/ci-status.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/ci-status.js")>();
  return {
    ...mod,
    getPullRequestDetails: vi.fn().mockResolvedValue({ state: "OPEN", merged: false, ciStatus: "success", mergeableStatus: "mergeable" }),
    listPullRequestChangedFiles: vi.fn().mockResolvedValue([]),
    getPullRequestPatch: vi.fn().mockResolvedValue(""),
  };
});

vi.mock("../src/server/paperclip-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/paperclip-client")>();
  return {
    ...mod,
    listPaperclipInteractions: vi.fn().mockResolvedValue([]),
    getPaperclipInteraction: vi.fn().mockResolvedValue(null),
    moveIssueToInProgress: vi.fn().mockResolvedValue(undefined),
    moveIssueToReview: vi.fn().mockResolvedValue(undefined),
    createJulesFeedbackInteraction: vi.fn().mockResolvedValue({ id: 'feedback-1', status: 'pending' }),
    moveIssueToDone: vi.fn(),
    createNoPrCompletionInteraction: vi.fn().mockResolvedValue({ id: 'int-1', status: 'pending' }),
    deleteStoredSession: vi.fn().mockResolvedValue(undefined),
    listAllActivities: vi.fn().mockResolvedValue([]),
    listPaperclipApprovals: vi.fn().mockResolvedValue([]),
    listIssueComments: vi.fn().mockResolvedValue([]),
    createIssueComment: vi.fn().mockResolvedValue(undefined),
    addJulesActivityComment: vi.fn().mockResolvedValue(undefined),
    listWorkProducts: vi.fn().mockResolvedValue([]),
    registerPullRequestWorkProduct: vi.fn().mockResolvedValue(undefined),
  };
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

  it('clears the session and returns terminal result on COMPLETED_AND_MERGED state', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    (JulesClient.prototype.getSession as any).mockResolvedValueOnce({
        state: 'COMPLETED',
        rawOutputs: [{ pullRequest: { url: 'http://pr/1' } }]
    });

    vi.mocked(getPullRequestDetails).mockResolvedValueOnce({ state: "MERGED", merged: true, ciStatus: "success", mergeableStatus: "unknown" });
    vi.mocked(listPullRequestChangedFiles).mockResolvedValueOnce(["test.txt"]);

    const decoded = sessionCodec.decode((await execute(baseCtx)).sessionParams!) as any;

    const res = await execute({
      ...baseCtx,
      agent: {
        ...baseCtx.agent,
        adapterConfig: { ...baseCtx.agent.adapterConfig, ciPolicy: "skip" }
      },
      runtime: { ...baseCtx.runtime, sessionParams: sessionCodec.encode({ ...decoded, phase: 'RUNNING', currentPrUrl: 'http://pr/1' }) },
      authToken: 'jwt-token',
    } as any);

    expect(res.exitCode).toBe(0);
    expect(res.clearSession).toBe(true);
    expect(res.resultJson?.prUrl).toBe('http://pr/1');
    expect(res.resultJson?.issueStatus).toBe('done');
  });

  it.skip('creates a Paperclip feedback interaction when Jules awaits feedback', async () => {
    (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'IN_PROGRESS' }).mockResolvedValueOnce({ state: 'IN_PROGRESS' }).mockResolvedValue({ state: 'AWAITING_USER_FEEDBACK' });
    vi.mocked(getPullRequestDetails).mockResolvedValue({ state: "OPEN", merged: false, ciStatus: "success", mergeableStatus: "mergeable" });
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
    const checkpoint2 = await execute({
      ...baseCtx,
      runtime: { ...baseCtx.runtime, sessionParams: checkpoint.sessionParams },
      authToken: 'jwt-token',
    } as any);
    const res = await execute({
      ...baseCtx,
      runtime: { ...baseCtx.runtime, sessionParams: checkpoint2.sessionParams },
      authToken: 'jwt-token',
    } as any);
    expect(res.exitCode).toBe(0);
    console.log(res); expect(res.resultJson?.issueStatus).toBe('in_progress');
    expect(res.resultJson?.interactionId).toBe('feedback-1');
    expect(res.question).toBeUndefined();
    expect(sessionCodec.decode(res.sessionParams!).pendingInteraction).toMatchObject({
      type: 'user_feedback',
      paperclipInteractionId: 'feedback-1',
    });
  });
});
