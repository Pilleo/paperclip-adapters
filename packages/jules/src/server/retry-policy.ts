import { FailureClassification } from './failure-classifier.js';
import { AdapterConfig } from './config.js';

export function getRetryNotBefore(
  failedAttemptCount: number,
  options: { now?: number; random?: number; retryAfterMs?: number | null } = {},
): number {
  const delays = [2, 10, 30]; // Minutes

  // Example counting based on explicit feedback requesting failure counting:
  // attempt 1 fails -> failedAttemptCount = 1 -> delay 2 min
  // attempt 2 fails -> failedAttemptCount = 2 -> delay 10 min
  // attempt 3 fails -> failedAttemptCount = 3 -> delay 30 min
  const index = Math.max(0, failedAttemptCount - 1);
  const delayMinutes = delays[Math.min(index, delays.length - 1)] ?? 30;

  const baseDelayMs = delayMinutes * 60 * 1000;
  const random = Math.min(1, Math.max(0, options.random ?? Math.random()));
  // Full systems tend to retry together after an outage. A bounded +/-1%
  // jitter spreads those heartbeats without materially changing the policy.
  const jitteredDelayMs = Math.round(baseDelayMs * (0.99 + random * 0.02));
  const delayMs = Math.max(jitteredDelayMs, options.retryAfterMs ?? 0);
  return (options.now ?? Date.now()) + delayMs;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function shouldRetry(
  classification: FailureClassification,
  failedAttemptCount: number,
  config: AdapterConfig
): boolean {
  if (classification === "configuration" || classification === "task") {
    return false;
  }

  if (classification === "unknown") {
    // Allows 1 retry
    return failedAttemptCount < 2; // if attempt 1 fails, failedAttemptCount is 1 -> < 2 -> true.
  }

  if (classification === "transient") {
    return failedAttemptCount <= config.maxAutomaticRestarts;
  }

  return false;
}
