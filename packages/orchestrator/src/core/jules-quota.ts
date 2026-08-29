import { JulesQuotaStatus } from "./types.js";

export const DEFAULT_MAX_CONCURRENT_JULES = 15;
export const DEFAULT_MAX_DAILY_JULES = 100;

export const JULES_ACTIVE_STATES = Object.freeze([
  "QUEUED",
  "PLANNING",
  "IN_PROGRESS",
  "AWAITING_USER_FEEDBACK",
  "AWAITING_PLAN_APPROVAL",
]);

/**
 * Pure calculation: evaluates active sessions and rolling 24h quota against limits.
 */
export function calculateJulesCapacity(
  sessions: readonly { readonly state?: string; readonly createTime?: string }[],
  nowMs = Date.now(),
  maxConcurrent = DEFAULT_MAX_CONCURRENT_JULES,
  maxDaily = DEFAULT_MAX_DAILY_JULES
): JulesQuotaStatus {
  const activeStatesSet = new Set(JULES_ACTIVE_STATES);
  let activeCount = 0;
  let count24h = 0;
  const cutoff24h = nowMs - 24 * 60 * 60 * 1000;

  for (const session of sessions) {
    const state = (session.state || "").toUpperCase();
    if (activeStatesSet.has(state)) {
      activeCount++;
    }
    if (session.createTime) {
      const t = new Date(session.createTime).getTime();
      if (!isNaN(t) && t >= cutoff24h) {
        count24h++;
      }
    }
  }

  const availableConcurrent = Math.max(0, maxConcurrent - activeCount);
  const availableDaily = Math.max(0, maxDaily - count24h);
  const effective = Math.min(availableConcurrent, availableDaily);

  return Object.freeze({
    activeSessionsCount: activeCount,
    sessionsLast24hCount: count24h,
    maxConcurrent,
    maxDaily,
    availableConcurrentSlots: availableConcurrent,
    availableDailySlots: availableDaily,
    effectiveAvailableCapacity: effective,
    fetchedLive: true,
  });
}

/**
 * I/O fetcher: queries Google Jules API for recent sessions.
 */
export async function fetchJulesQuota(
  apiKey?: string | null,
  maxConcurrent = DEFAULT_MAX_CONCURRENT_JULES,
  maxDaily = DEFAULT_MAX_DAILY_JULES
): Promise<JulesQuotaStatus> {
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return Object.freeze({
      activeSessionsCount: 0,
      sessionsLast24hCount: 0,
      maxConcurrent,
      maxDaily,
      availableConcurrentSlots: maxConcurrent,
      availableDailySlots: maxDaily,
      effectiveAvailableCapacity: maxConcurrent,
      fetchedLive: false,
    });
  }

  try {
    const res = await fetch("https://jules.googleapis.com/v1alpha/sessions?pageSize=100", {
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey.trim(),
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return Object.freeze({
        activeSessionsCount: 0,
        sessionsLast24hCount: 0,
        maxConcurrent,
        maxDaily,
        availableConcurrentSlots: maxConcurrent,
        availableDailySlots: maxDaily,
        effectiveAvailableCapacity: maxConcurrent,
        fetchedLive: false,
        error: `Jules API error (${res.status}): ${errText}`,
      });
    }

    const data = (await res.json()) as { sessions?: Array<{ state?: string; createTime?: string }> };
    const sessions = data.sessions || [];

    return calculateJulesCapacity(sessions, Date.now(), maxConcurrent, maxDaily);
  } catch (err: any) {
    return Object.freeze({
      activeSessionsCount: 0,
      sessionsLast24hCount: 0,
      maxConcurrent,
      maxDaily,
      availableConcurrentSlots: maxConcurrent,
      availableDailySlots: maxDaily,
      effectiveAvailableCapacity: maxConcurrent,
      fetchedLive: false,
      error: err.message,
    });
  }
}
