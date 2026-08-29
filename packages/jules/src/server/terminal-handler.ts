import { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { JulesAdapterSessionV1, serializeSession } from "./session.js";

export function completionInteractionResult(
  session: JulesAdapterSessionV1,
  issueStatus: "blocked" | "done",
  summary: string,
  clearSession: boolean
): AdapterExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionParams: serializeSession(session),
    sessionDisplayId: session.julesSessionId ?? null,
    summary,
    resultJson: {
      provider: "jules",
      julesSessionId: session.julesSessionId,
      julesState: session.julesState ?? session.phase,
      issueStatus,
      interactionId: session.pendingInteraction?.paperclipInteractionId,
      completedWithoutPr: true,
    },
    clearSession,
  };
}

export function createPendingResult(
  session: JulesAdapterSessionV1,
  summary: string,
  nextRunDelayMs?: number
): AdapterExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionParams: serializeSession(session),
    sessionDisplayId: session.julesSessionId ?? null,
    summary,
    resultJson: {
      provider: "jules",
      julesSessionId: session.julesSessionId,
      julesState: session.julesState ?? session.phase,
      interactionId: session.pendingInteraction?.paperclipInteractionId,
      nextRunDelayMs,
    },
  };
}
