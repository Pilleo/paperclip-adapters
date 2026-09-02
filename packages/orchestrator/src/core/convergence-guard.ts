/**
 * Adapter-local idempotency/concurrency guard for Paperclip side effects.
 *
 * Paperclip can deliver overlapping heartbeats for the same issue. A read-then-
 * write check (for example, "audit comment is absent") is therefore unsafe:
 * two ticks can both pass the check and both post the effect. This guard makes
 * the logical operation single-flight within the long-lived orchestrator
 * adapter process. It is intentionally keyed by a stable operation identity.
 *
 * This is a compatibility layer until Paperclip exposes conditional writes or
 * server-side idempotency keys. It does not replace durable reconciliation:
 * an adapter restart must still re-read the board and converge safely.
 */
export class ConvergenceGuard {
  private readonly completed = new Map<string, unknown>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  async runOnce<T>(key: string, effect: () => Promise<T>): Promise<T> {
    if (this.completed.has(key)) return this.completed.get(key) as T;

    const existing = this.inFlight.get(key);
    if (existing) return await existing as T;

    const operation = (async () => {
      const result = await effect();
      this.completed.set(key, result);
      return result;
    })();
    this.inFlight.set(key, operation);

    try {
      return await operation;
    } finally {
      this.inFlight.delete(key);
    }
  }

  clear(key: string): void {
    this.completed.delete(key);
  }

  hasCompleted(key: string): boolean {
    return this.completed.has(key);
  }
}

