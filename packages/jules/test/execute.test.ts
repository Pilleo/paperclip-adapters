import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { JulesClient } from '../src/server/jules-client';
import { sessionCodec } from '../src/server/session';
import { getPaperclipIssue, moveIssueToReview } from '../src/server/paperclip-client';
import { getPullRequestDetails } from '../src/server/ci-status';

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

vi.mock('../src/server/ci-status.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/server/ci-status.js')>();
  return {
    ...mod,
    getPullRequestDetails: vi.fn().mockResolvedValue({ merged: false, ciStatus: "success" }),
    listPullRequestChangedFiles: vi.fn().mockResolvedValue([]),
    getPullRequestPatch: vi.fn().mockResolvedValue(""),
    getPullRequestCiStatus: vi.fn().mockResolvedValue("success"),
  };
});

// Monitor persistence belongs to Paperclip and is exercised by the dedicated
// paperclip-client tests.  Keep execute lifecycle tests offline and focused on
// the Jules state machine.
vi.mock('../src/server/paperclip-client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/server/paperclip-client')>();
  return {
    ...mod,
    listPaperclipInteractions: vi.fn().mockResolvedValue([]),
    listIssueComments: vi.fn().mockResolvedValue([]),
    addJulesActivityComment: vi.fn().mockResolvedValue(undefined),
    createJulesAgentAdjudicationInteraction: vi.fn().mockResolvedValue({ id: "visible-question-1", status: "pending" }),
    createJulesQuestionAdjudication: vi.fn().mockResolvedValue({ id: "adjudication-1" }),
    scheduleJulesSessionMonitor: vi.fn().mockResolvedValue(undefined),
    getPaperclipIssue: vi.fn().mockResolvedValue({ id: "plan-review-1", status: "blocked" }),
    moveIssueToReview: vi.fn().mockResolvedValue(undefined),
    completeInternalReviewIssue: vi.fn().mockResolvedValue(undefined),
    withdrawPaperclipInteraction: vi.fn().mockResolvedValue(undefined),
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
          heartbeatPollWindowSeconds: 30,
          questionReviewerAgentId: "00000000-0000-4000-8000-000000000001",
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
    expect(res.summary).toBeUndefined();
  });

  it('moves the issue to review on COMPLETED state with PR', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    (JulesClient.prototype.getSession as any).mockResolvedValue({
        state: 'COMPLETED',
        rawOutputs: [{ pullRequest: { url: 'http://pr/1' } }]
    });

    const res = await execute({
      ...baseCtx,
      agent: {
        ...baseCtx.agent,
        adapterConfig: { ...baseCtx.agent.adapterConfig, ciPolicy: "skip" }
      },
      runtime: {
        ...baseCtx.runtime,
        sessionParams: sessionCodec.encode({
          version: 1,
          paperclipIssueId: "task-1",
          promptHash: "stable-hash",
          promptHashVersion: 2,
          repository: "pilleo/test",
          source: "github",
          baseBranch: "master",
          phase: "RUNNING",
          sessionId: "123",
          julesSessionId: "123",
          attempt: 1,
          failedSessions: [],
          createdAt: new Date().toISOString(),
        } as never),
      },
      authToken: 'jwt-token',
    } as any);
    expect(res.exitCode).toBe(0);
    expect(res.clearSession).toBe(false);
    expect(res.resultJson?.prUrl).toBe('http://pr/1');
    expect(res.resultJson?.issueStatus).toBe('in_review');
  });

  it('does not let a stale unanswered plan review block a completed PR handoff', async () => {
    (JulesClient.prototype.getSession as any).mockResolvedValue({
      state: 'COMPLETED',
      rawOutputs: [],
    });

    const res = await execute({
      ...baseCtx,
      agent: {
        ...baseCtx.agent,
        adapterConfig: { ...baseCtx.agent.adapterConfig, ciPolicy: "skip" },
      },
      runtime: {
        ...baseCtx.runtime,
        sessionParams: sessionCodec.encode({
          version: 1,
          paperclipIssueId: "task-1",
          promptHash: "stable-hash",
          promptHashVersion: 2,
          repository: "pilleo/test",
          source: "github",
          baseBranch: "master",
          phase: "RUNNING",
          sessionId: "123",
          julesSessionId: "123",
          attempt: 1,
          failedSessions: [],
          createdAt: new Date().toISOString(),
          julesState: "COMPLETED",
          currentPrUrl: "https://github.com/Pilleo/paperclip-adapters/pull/3",
          pendingInteraction: {
            type: "plan_agent_review",
            julesActivityId: "activity-plan",
            question: "Review this plan",
            planRevisionId: "revision-1",
            planRevisionNumber: 1,
            planDocumentId: "document-1",
            reviewIssueId: "plan-review-1",
            reviewerAgentId: "reviewer-1",
            stage: "vibe",
            createdAt: new Date().toISOString(),
          },
        } as never),
      },
      authToken: 'jwt-token',
    } as any);

    expect(res.resultJson?.issueStatus).toBe('in_review');
    expect(moveIssueToReview).toHaveBeenCalledWith(
      'task-1',
      'https://github.com/Pilleo/paperclip-adapters/pull/3',
      'jwt-token',
      'run-1',
    );
  });

  it('does not reopen a completed PR for a pre-completion plan prompt', async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      state: 'COMPLETED',
      rawOutputs: [],
    } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [
        {
          id: 'plan-prompt',
          createTime: '2026-08-31T00:00:01.000Z',
          agentMessaged: { agentMessage: 'I have created a plan. Could you approve it?' },
        },
        {
          id: 'session-completed',
          createTime: '2026-08-31T00:00:02.000Z',
          sessionCompleted: {},
        },
      ],
    } as never);

    const res = await execute({
      ...baseCtx,
      agent: {
        ...baseCtx.agent,
        adapterConfig: { ...baseCtx.agent.adapterConfig, ciPolicy: "skip" },
      },
      runtime: {
        ...baseCtx.runtime,
        sessionParams: sessionCodec.encode({
          version: 1,
          paperclipIssueId: "task-1",
          promptHash: "stable-hash",
          promptHashVersion: 2,
          repository: "pilleo/test",
          source: "github",
          baseBranch: "master",
          phase: "RUNNING",
          sessionId: "123",
          julesSessionId: "123",
          attempt: 1,
          failedSessions: [],
          createdAt: new Date().toISOString(),
          currentPrUrl: "https://github.com/example/repo/pull/3",
          pendingInteraction: {
            type: "plan_agent_review",
            julesActivityId: "plan-prompt",
            question: "Review this plan",
            planRevisionId: "revision-1",
            planRevisionNumber: 1,
            planDocumentId: "document-1",
            reviewIssueId: "plan-review-1",
            reviewerAgentId: "reviewer-1",
            stage: "vibe",
            createdAt: new Date().toISOString(),
          },
        } as never),
      },
      authToken: 'jwt-token',
    } as any);

    expect(res.resultJson?.issueStatus).toBe('in_review');
    expect(moveIssueToReview).toHaveBeenCalled();
    expect(getPaperclipIssue).not.toHaveBeenCalledWith('plan-review-1', expect.anything(), expect.anything());
  });

  it('delegates a Jules question to the configured strong reviewer', async () => {
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
    expect(res.resultJson?.pending).toBe(true);
    expect(res.question).toBeUndefined();
    expect(sessionCodec.decode(res.sessionParams!).pendingInteraction).toMatchObject({
      type: 'agent_adjudication',
      adjudicationIssueId: 'adjudication-1',
    });
  });
});
