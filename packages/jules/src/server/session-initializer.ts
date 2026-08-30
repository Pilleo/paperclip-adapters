import { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { AdapterConfig, discoverLocalGitRepository, discoverLocalGitDefaultBranch } from "./config.js";
import { isGhCliAuthenticated, createRemoteGitHubRepo } from "./git-remote-creator.js";
import { JulesAdapterSessionV1, serializeSession } from "./session.js";
import { JulesClient } from "./jules-client.js";
import { buildPrompt, hashPromptIdentity } from "./prompt-builder.js";
import { asJulesSessionId, asPaperclipId } from "./brands.js";
import { postSessionLink, upsertJulesSessionHandle } from "./paperclip-client.js";
import { sanitizeError } from "./error-sanitizer.js";
import { saveStoredSession } from "./session-store.js";

export interface SessionInitializationResult {
  session: JulesAdapterSessionV1;
  createdSessionThisRun: boolean;
  promptHash: string;
}

export async function persistSessionBestEffort(
  session: JulesAdapterSessionV1,
  onLog: AdapterExecutionContext["onLog"] | undefined,
  paperclip?: { authToken?: string | undefined; runId?: string | undefined },
): Promise<void> {
  try {
    await saveStoredSession(session);
  } catch (error) {
    if (onLog) {
      await onLog("stderr", `[jules] Could not persist local recovery record: ${sanitizeError(error)}\n`);
    }
  }
  const sessionId = session.julesSessionId || session.sessionId;
  const issueId = session.paperclipIssueId;
  if (!sessionId || !issueId) return;
  try {
    await upsertJulesSessionHandle(
      issueId,
      sessionId,
      session.julesSessionUrl ?? null,
      paperclip?.authToken,
      paperclip?.runId,
    );
  } catch (error) {
    if (onLog) {
      await onLog("stderr", `[jules] Could not persist Paperclip session handle: ${sanitizeError(error)}\n`);
    }
  }
}

export async function initializeOrResumeSession(
  client: JulesClient,
  config: AdapterConfig,
  session: JulesAdapterSessionV1 | null,
  taskId: string,
  taskTitle: string,
  taskDescription: string,
  ctx: AdapterExecutionContext,
): Promise<SessionInitializationResult> {
  let createdSessionThisRun = false;
  const isRetry = session?.phase === "RETRY_SCHEDULED";
  const failedSessions = session?.failedSessions || [];
  const attempt = isRetry && session ? session.attempt + 1 : 1;

  const promptContext = {
    issueId: taskId,
    runId: ctx.runId,
    title: taskTitle,
    description: taskDescription,
    isRetry,
    resumeAttempt: isRetry ? attempt : 0,
    failedSessionUrl: failedSessions.length > 0 ? `Session ID: ${failedSessions[failedSessions.length - 1]?.sessionId}` : undefined,
    failedSessionMessage: failedSessions.length > 0 ? failedSessions[failedSessions.length - 1]?.message : undefined,
    priorPrUrls: (session?.failedSessions ?? [])
      .map((fs) => fs.prUrl)
      .filter((url): url is string => Boolean(url)),
  };

  const prompt = buildPrompt(promptContext, config);
  const pHash = hashPromptIdentity(promptContext, config);

  if (!session || isRetry) {
    const julesSession = await client.createSession({
      prompt,
      title: taskTitle,
      sourceContext: {
        source: config.source,
        githubRepoContext: {
          startingBranch: config.baseBranch,
        },
      },
      requirePlanApproval: config.requirePlanApproval,
      automationMode: config.automationMode,
    });

    createdSessionThisRun = true;
    session = {
      version: 1,
      paperclipIssueId: asPaperclipId(taskId),
      promptHash: pHash,
      repository: config.repository,
      source: config.source,
      baseBranch: config.baseBranch,
      sessionId: asJulesSessionId(julesSession.id),
      julesSessionId: asJulesSessionId(julesSession.id),
      julesSessionUrl: julesSession.url,
      julesState: julesSession.state,
      phase: "RUNNING",
      attempt,
      failedSessions,
      createdAt: new Date().toISOString(),
      lastPolledAt: new Date().toISOString(),
    };

    if (julesSession.url) {
      try {
        await postSessionLink(taskId, julesSession.url, ctx.authToken, ctx.runId);
      } catch (err) {
        if (ctx.onLog) {
          await ctx.onLog("stderr", `[jules] Failed to post session link to Paperclip: ${sanitizeError(err)}\n`);
        }
      }
    }
    await persistSessionBestEffort(session, ctx.onLog, { authToken: ctx.authToken, runId: ctx.runId });
  }

  return { session, createdSessionThisRun, promptHash: pHash };
}
