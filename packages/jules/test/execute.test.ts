import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { execute } from '../src/server/execute';
import { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { JulesClient } from '../src/server/jules-client';
import { sessionCodec } from '../src/server/session';
import { getPaperclipInteraction, getPaperclipIssue, listPaperclipInteractions, moveIssueToReview, registerPullRequestWorkProduct, withdrawPaperclipInteraction } from '../src/server/paperclip-client';
import { getPullRequestCiStatus, getPullRequestDetails } from '../src/server/ci-status';

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
    getPaperclipInteraction: vi.fn().mockResolvedValue({ id: "test-interaction", status: "pending" }),
    registerPullRequestWorkProduct: vi.fn().mockResolvedValue(undefined),
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
    // Keep each lifecycle test independent. A prior test may install a
    // minimal fetch stub; the question bridge needs a JSON-capable response.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "test-interaction", status: "pending", kind: "ask_user_questions" }),
    });
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
    // Paperclip promotes resultJson.nextAction into run liveness and treats
    // prose such as "Continue polling" as an immediate retry request. The
    // durable Jules monitor owns this cadence, so a normal pending result
    // must not publish a competing host-level next action.
    expect(res.resultJson).not.toHaveProperty('nextAction');
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
      config: {
        ...baseCtx.config,
        env: { JULES_API_KEY: 'test-key', PAPERCLIP_GITHUB_BROKER_TOKEN: 'run-scoped-token' },
      },
    } as any);
    expect(res.exitCode).toBe(0);
    expect(res.clearSession).toBe(false);
    expect(res.resultJson?.prUrl).toBe('http://pr/1');
    expect(res.resultJson?.issueStatus).toBe('in_review');
    expect(getPullRequestDetails).toHaveBeenCalledWith(
      'http://pr/1',
      expect.objectContaining({
        env: expect.objectContaining({ PAPERCLIP_GITHUB_BROKER_TOKEN: 'run-scoped-token' }),
      }),
    );
  });

  it('withdraws a same-session no-PR confirmation before handing a later discovered PR to review', async () => {
    (JulesClient.prototype.getSession as any).mockResolvedValue({
      state: 'COMPLETED',
      rawOutputs: [{ pullRequest: { url: 'https://github.com/pilleo/test/pull/1549' } }],
    });
    vi.mocked(getPullRequestDetails).mockResolvedValue({
      state: 'OPEN', merged: false, ciStatus: 'success', inspectionStatus: 'observed',
      mergeableStatus: 'mergeable', headSha: 'a'.repeat(40), headRefName: 'jules-1549',
    });
    vi.mocked(getPaperclipInteraction).mockResolvedValue({ id: 'stale-no-pr-card', status: 'pending' } as never);

    const result = await execute({
      ...baseCtx,
      agent: { ...baseCtx.agent, adapterConfig: { ...baseCtx.agent.adapterConfig, ciPolicy: 'skip' } },
      runtime: {
        ...baseCtx.runtime,
        sessionParams: sessionCodec.encode({
          version: 1, paperclipIssueId: 'task-1', promptHash: 'stable-hash', promptHashVersion: 2,
          repository: 'pilleo/test', source: 'github', baseBranch: 'master', phase: 'COMPLETED',
          sessionId: '123', julesSessionId: '123', attempt: 1, failedSessions: [], createdAt: new Date().toISOString(),
          pendingInteraction: {
            type: 'completion_confirmation', paperclipInteractionId: 'stale-no-pr-card',
            question: 'Jules completed without a PR. Is this task complete?', createdAt: new Date().toISOString(),
          },
        } as never),
      },
      authToken: 'jwt-token',
    } as any);

    expect(withdrawPaperclipInteraction).toHaveBeenCalledWith(
      'task-1', 'stale-no-pr-card', 'Superseded by a pull request discovered for the same Jules session', 'jwt-token', 'run-1',
    );
    expect(registerPullRequestWorkProduct).toHaveBeenCalledWith(
      'task-1', 'https://github.com/pilleo/test/pull/1549', 'jwt-token', 'run-1', expect.objectContaining({
        headSha: 'a'.repeat(40), headRefName: 'jules-1549', ciStatus: 'success', changedFiles: [],
      }),
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toBeUndefined();
    expect(result.resultJson).toMatchObject({ prUrl: 'https://github.com/pilleo/test/pull/1549', issueStatus: 'in_review' });
  });

  it("schedules branch-bound remediation instead of messaging a terminal Jules session with red CI", async () => {
    (JulesClient.prototype.getSession as any).mockResolvedValue({
      state: "COMPLETED",
      rawOutputs: [{ pullRequest: { url: "https://github.com/Pilleo/paperclip-adapters/pull/11" } }],
    });
    vi.mocked(getPullRequestDetails).mockResolvedValue({
      state: "OPEN", merged: false, ciStatus: "failed", mergeableStatus: "mergeable",
      headSha: "a".repeat(40), headRefName: "jules-18036993849073318863-b259ffba",
    });

    const result = await execute({
      ...baseCtx,
      runtime: {
        ...baseCtx.runtime,
        sessionParams: sessionCodec.encode({
          version: 1, paperclipIssueId: "task-1", promptHash: "stable-hash", promptHashVersion: 2,
          repository: "pilleo/test", source: "github", baseBranch: "master", phase: "RUNNING",
          sessionId: "terminal-123", julesSessionId: "terminal-123", attempt: 1, failedSessions: [],
          createdAt: new Date().toISOString(), currentPrUrl: "https://github.com/Pilleo/paperclip-adapters/pull/11",
        } as never),
      },
      authToken: "jwt-token",
    } as any);

    expect(result.errorCode).toBe("jules_pr_remediation_scheduled");
    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({
      phase: "RETRY_SCHEDULED",
      currentPrHeadRef: "jules-18036993849073318863-b259ffba",
      prRemediation: { originalSessionId: "terminal-123", headRefName: "jules-18036993849073318863-b259ffba" },
    });
  });

  it('hands off a completed green PR without a second CI poll', async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      state: 'COMPLETED',
      rawOutputs: [{ pullRequest: { url: 'https://github.com/Pilleo/paperclip-adapters/pull/8' } }],
    } as never);
    vi.mocked(getPullRequestDetails).mockResolvedValue({
      state: 'OPEN',
      merged: false,
      ciStatus: 'success',
      mergeableStatus: 'mergeable',
      headSha: 'b676f30f8dcfbaaebd8629e4cd0f1eb1622c88e8',
    });
    // This models the live failure: the independent follow-up probe can hang
    // or report stale pending state after the authoritative details probe is green.
    vi.mocked(getPullRequestCiStatus).mockResolvedValue('pending');

    const res = await execute({
      ...baseCtx,
      runtime: {
        ...baseCtx.runtime,
        sessionParams: sessionCodec.encode({
          version: 1,
          paperclipIssueId: 'task-1',
          promptHash: 'stable-hash',
          promptHashVersion: 2,
          repository: 'pilleo/test',
          source: 'sources/github/pilleo/test',
          baseBranch: 'master',
          phase: 'RUNNING',
          sessionId: '123',
          julesSessionId: '123',
          attempt: 1,
          failedSessions: [],
          createdAt: new Date().toISOString(),
        } as never),
      },
      authToken: 'jwt-token',
    } as any);

    expect(res.resultJson?.issueStatus).toBe('in_review');
    expect(moveIssueToReview).toHaveBeenCalledWith(
      'task-1',
      'https://github.com/Pilleo/paperclip-adapters/pull/8',
      'jwt-token',
      'run-1',
    );
    expect(getPullRequestCiStatus).not.toHaveBeenCalled();
  });

  it('keeps an unresolved provider question ahead of PR handoff', async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      state: 'AWAITING_USER_FEEDBACK',
      rawOutputs: [{ pullRequest: { url: 'http://pr/with-question' } }],
    } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [{
        id: 'provider-question-1',
        createTime: new Date().toISOString(),
        agentMessaged: { agentMessage: 'Should I proceed with the PR?' },
      }],
    } as never);

    const res = await execute({
      ...baseCtx,
      agent: {
        ...baseCtx.agent,
        adapterConfig: { ...baseCtx.agent.adapterConfig, ciPolicy: 'skip' },
      },
      runtime: {
        ...baseCtx.runtime,
        sessionParams: sessionCodec.encode({
          version: 1,
          paperclipIssueId: 'task-1',
          promptHash: 'stable-hash',
          promptHashVersion: 2,
          repository: 'pilleo/test',
          source: 'sources/github/pilleo/test',
          baseBranch: 'master',
          phase: 'RUNNING',
          sessionId: '123',
          julesSessionId: '123',
          attempt: 1,
          failedSessions: [],
          createdAt: new Date().toISOString(),
        } as never),
      },
    } as any);

    expect(res.resultJson).toMatchObject({ pending: true });
    expect(res.resultJson?.issueStatus).not.toBe('in_review');
    expect(res.clearSession).toBe(false);
    expect(moveIssueToReview).not.toHaveBeenCalled();
  });

  it('reconciles the provider question even when PR inspection is unavailable', async () => {
    vi.mocked(getPullRequestDetails).mockRejectedValueOnce(new Error('GitHub inspection unavailable'));
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      state: 'AWAITING_USER_FEEDBACK',
      rawOutputs: [{ pullRequest: { url: 'http://pr/with-question' } }],
    } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [{
        id: 'provider-question-before-pr-inspection',
        createTime: new Date().toISOString(),
        agentMessaged: { agentMessage: 'Should I proceed with the PR?' },
      }],
    } as never);

    const res = await execute({
      ...baseCtx,
      agent: {
        ...baseCtx.agent,
        adapterConfig: { ...baseCtx.agent.adapterConfig, ciPolicy: 'skip' },
      },
      runtime: {
        ...baseCtx.runtime,
        sessionParams: sessionCodec.encode({
          version: 1,
          paperclipIssueId: 'task-1',
          promptHash: 'stable-hash',
          promptHashVersion: 2,
          repository: 'pilleo/test',
          source: 'github',
          baseBranch: 'master',
          phase: 'RUNNING',
          sessionId: '123',
          julesSessionId: '123',
          attempt: 1,
          failedSessions: [],
          createdAt: new Date().toISOString(),
        } as never),
      },
    } as any);

    expect(res.resultJson).toMatchObject({ pending: true });
    expect(res.clearSession).toBe(false);
    expect(moveIssueToReview).not.toHaveBeenCalled();
  });

  it('does not let a stale unanswered plan review block a completed PR handoff', async () => {
    (JulesClient.prototype.getSession as any).mockResolvedValue({
      state: 'COMPLETED',
      rawOutputs: [],
    });
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);

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

  it('moves a completed persisted PR to review when Jules later records a plan activity', async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValueOnce({
      state: 'COMPLETED',
      rawOutputs: [],
    } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValueOnce({ activities: [
      {
        id: 'approved-plan',
        createTime: '2026-09-13T13:00:00.000Z',
        planGenerated: { plan: { steps: [{ index: 1, title: 'Approved work' }] } },
      },
      {
        id: 'late-plan',
        createTime: '2026-09-13T13:30:00.000Z',
        planGenerated: { plan: { steps: [{ index: 1, title: 'Terminal summary plan' }] } },
      },
      { id: 'completed', createTime: '2026-09-13T14:00:00.000Z', sessionCompleted: {} },
    ] } as never);

    const res = await execute({
      ...baseCtx,
      agent: {
        ...baseCtx.agent,
        adapterConfig: { ...baseCtx.agent.adapterConfig, ciPolicy: 'skip' },
      },
      runtime: {
        ...baseCtx.runtime,
        sessionParams: sessionCodec.encode({
          version: 1,
          paperclipIssueId: 'task-1',
          promptHash: 'stable-hash',
          promptHashVersion: 2,
          repository: 'pilleo/test',
          source: 'sources/github/pilleo/test',
          baseBranch: 'master',
          phase: 'WAITING_FOR_PLAN_APPROVAL',
          sessionId: '123',
          julesSessionId: '123',
          attempt: 1,
          failedSessions: [],
          createdAt: new Date().toISOString(),
          currentPrUrl: 'https://github.com/Pilleo/paperclip-adapters/pull/10',
          currentPrHeadSha: '270cd3338ebec40c79a74a2f05a652667ef4ec57',
          planApprovedAt: '2026-09-13T13:01:00.000Z',
          planApprovedActivityId: 'approved-plan',
        } as never),
      },
      authToken: 'jwt-token',
    } as any);

    expect(res.resultJson?.issueStatus).toBe('in_review');
    expect(moveIssueToReview).toHaveBeenCalledWith(
      'task-1',
      'https://github.com/Pilleo/paperclip-adapters/pull/10',
      'jwt-token',
      'run-1',
    );
  });

  it('does not reconnect an answered pre-completion question ahead of a completed PR', async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValueOnce({ state: 'COMPLETED', rawOutputs: [] } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValueOnce({ activities: [
      { id: 'answered-before-completion', createTime: '2026-09-13T13:28:11.983Z', agentMessaged: { agentMessage: 'May I proceed?' } },
      { id: 'late-plan', createTime: '2026-09-13T13:58:28.173Z', planGenerated: { plan: { steps: [{ index: 1, title: 'Terminal summary plan' }] } } },
      { id: 'completed', createTime: '2026-09-13T14:03:13.538Z', sessionCompleted: {} },
    ] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: 'answered-question-form',
      kind: 'ask_user_questions',
      status: 'answered',
      idempotencyKey: 'jules:agent-adjudication:task-1:123:answered-before-completion',
      result: {
        answers: [
          { questionId: 'resolution', optionIds: ['answer'] },
          { questionId: 'response', otherText: 'Proceed with the approved scoped plan.' },
        ],
      },
    }] as never);

    const res = await execute({
      ...baseCtx,
      agent: {
        ...baseCtx.agent,
        adapterConfig: { ...baseCtx.agent.adapterConfig, ciPolicy: 'skip', requirePlanApproval: true },
      },
      runtime: {
        ...baseCtx.runtime,
        sessionParams: sessionCodec.encode({
          version: 1, paperclipIssueId: 'task-1', promptHash: 'stable-hash', promptHashVersion: 2,
          repository: 'pilleo/test', source: 'sources/github/pilleo/test', baseBranch: 'master', phase: 'WAITING_FOR_PLAN_APPROVAL',
          sessionId: '123', julesSessionId: '123', attempt: 1, failedSessions: [], createdAt: new Date().toISOString(),
          currentPrUrl: 'https://github.com/Pilleo/paperclip-adapters/pull/10',
          currentPrHeadSha: '270cd3338ebec40c79a74a2f05a652667ef4ec57',
          planApprovedAt: '2026-09-13T13:28:07.459Z', planApprovedActivityId: 'approved-plan',
        } as never),
      },
      authToken: 'jwt-token',
    } as any);

    expect(res.resultJson?.issueStatus).toBe('in_review');
    expect(moveIssueToReview).toHaveBeenCalledWith(
      'task-1', 'https://github.com/Pilleo/paperclip-adapters/pull/10', 'jwt-token', 'run-1',
    );
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
      nativeForm: true,
      paperclipInteractionId: 'visible-question-1',
    });
  });
});
