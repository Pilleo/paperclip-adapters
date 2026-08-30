export interface ResilientFetchOptions {
  readonly maxRetries?: number | undefined; // default 3
  readonly baseDelayMs?: number | undefined; // default 100ms (100ms, 300ms, 900ms)
  readonly timeoutMs?: number | undefined; // default 15000ms
  readonly fetchFn?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
}

/**
 * Resilient HTTP fetch wrapper with exponential backoff for Paperclip control plane.
 * Retries on transient network errors (ECONNRESET, ETIMEDOUT) and 5xx server errors.
 */
export async function resilientFetch(
  url: string,
  init?: RequestInit,
  options: ResilientFetchOptions = {}
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelayMs ?? 100;
  const timeoutMs = options.timeoutMs ?? 15000;
  const fetchImpl = options.fetchFn ?? globalThis.fetch;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
      const requestInit: RequestInit = {
        ...init,
        signal: init?.signal ? init.signal : controller.signal,
      };

      const response = await fetchImpl(url, requestInit);
      clearTimeout(timer);

      // If status is not a 5xx server error, return immediately (don't retry 4xx client errors)
      if (response.status < 500) {
        return response;
      }

      // 5xx error: prepare to retry if budget permits
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(3, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      return response;
      } finally {
        clearTimeout(timer);
      }
    } catch (err: unknown) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(3, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
