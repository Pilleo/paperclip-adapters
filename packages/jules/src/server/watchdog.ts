import { JulesAdapterSessionV1 } from "./session.js";

export const DEFAULT_STALL_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
export const MIN_NUDGE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes between nudges

export interface WatchdogEvaluation {
  shouldNudge: boolean;
  reason: string;
  nudgeMessage?: string;
  nudgeCount?: number;
}

export function evaluateSessionWatchdog(
  session: JulesAdapterSessionV1,
  lastActivityTime: string | null | undefined,
  nowMs: number = Date.now(),
  stallThresholdMs: number = DEFAULT_STALL_THRESHOLD_MS,
  minNudgeIntervalMs: number = MIN_NUDGE_INTERVAL_MS
): WatchdogEvaluation {
  // Only monitor active running/in-progress sessions
  const isActivelyWorking =
    session.phase === "RUNNING" ||
    session.julesState === "IN_PROGRESS" ||
    session.julesState === "PLANNING" ||
    session.julesState === "QUEUED";

  if (!isActivelyWorking) {
    return {
      shouldNudge: false,
      reason: `Session phase ${session.phase} (state: ${session.julesState}) is not actively working`
    };
  }

  if (session.pendingInteraction) {
    return {
      shouldNudge: false,
      reason: "Session is waiting on pending user interaction card"
    };
  }

  const baselineTimeStr = lastActivityTime || session.lastPolledAt || session.createdAt;
  if (!baselineTimeStr) {
    return {
      shouldNudge: false,
      reason: "No baseline timestamp available for watchdog evaluation"
    };
  }

  const baselineMs = new Date(baselineTimeStr).getTime();
  if (isNaN(baselineMs)) {
    return {
      shouldNudge: false,
      reason: "Invalid baseline timestamp format"
    };
  }

  const idleDurationMs = nowMs - baselineMs;
  if (idleDurationMs < stallThresholdMs) {
    return {
      shouldNudge: false,
      reason: `Session is active; idle for ${Math.round(idleDurationMs / 1000)}s (threshold ${stallThresholdMs / 1000}s)`
    };
  }

  // Check last nudge time to prevent spam
  const lastNudgeStr = (session as { lastWatchdogNudgeAt?: string }).lastWatchdogNudgeAt;
  if (lastNudgeStr) {
    const lastNudgeMs = new Date(lastNudgeStr).getTime();
    if (!isNaN(lastNudgeMs) && nowMs - lastNudgeMs < minNudgeIntervalMs) {
      return {
        shouldNudge: false,
        reason: `Nudge on cooldown; last nudged ${Math.round((nowMs - lastNudgeMs) / 1000)}s ago`
      };
    }
  }

  const currentNudgeCount = ((session as { watchdogNudgeCount?: number }).watchdogNudgeCount || 0) + 1;

  // A heartbeat is a poll/reconciliation event, not a provider conversation.
  // Sending synthetic prose here can overwrite a real Jules question or plan
  // approval request. Keep the stall diagnosis for logs/telemetry, but let the
  // durable monitor schedule the next poll without fabricating a message.
  return {
    shouldNudge: false,
    reason: `Session stalled in ${session.julesState || session.phase} for ${Math.round(idleDurationMs / 60000)} minutes`,
    nudgeCount: currentNudgeCount,
  };
}
