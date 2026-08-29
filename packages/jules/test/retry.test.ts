import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { shouldRetry, getRetryNotBefore, parseRetryAfter } from '../src/server/retry-policy';
import { AdapterConfig } from '../src/server/config';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('Failure Recovery & Retry Policy', () => {
  const config = { maxAutomaticRestarts: 3 } as AdapterConfig;

  beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('shouldRetry', () => {
    it('does not retry configuration errors', () => {
      expect(shouldRetry('configuration', 1, config)).toBe(false);
    });

    it('does not retry task errors', () => {
      expect(shouldRetry('task', 1, config)).toBe(false);
    });

    it('retries unknown errors once', () => {
      expect(shouldRetry('unknown', 1, config)).toBe(true);
      expect(shouldRetry('unknown', 2, config)).toBe(false);
    });

    it('retries transient errors up to maxAutomaticRestarts bounds precisely tracking attempt counts', () => {
      // 1st failure (attempt 1) -> retry? yes
      expect(shouldRetry('transient', 1, config)).toBe(true);
      // 3rd failure (attempt 3) -> retry? yes (max is 3)
      expect(shouldRetry('transient', 3, config)).toBe(true);
      // 4th failure (attempt 4) -> retry? no
      expect(shouldRetry('transient', 4, config)).toBe(false);
    });
  });

  beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('getRetryNotBefore accounting tracking delays accurately', () => {
    it('returns correct delay for attempt 1', () => {
      const now = Date.now();
      const notBefore = getRetryNotBefore(1);
      const delayMinutes = (notBefore - now) / 1000 / 60;
      expect(Math.round(delayMinutes)).toBe(2);
    });

    it('returns correct delay for attempt 2', () => {
        const now = Date.now();
        const notBefore = getRetryNotBefore(2);
        const delayMinutes = (notBefore - now) / 1000 / 60;
        expect(Math.round(delayMinutes)).toBe(10);
    });

    it('returns correct delay for attempt 3', () => {
      const now = Date.now();
      const notBefore = getRetryNotBefore(3);
      const delayMinutes = (notBefore - now) / 1000 / 60;
      expect(Math.round(delayMinutes)).toBe(30);
    });

    it('caps maximum retry delay correctly on large attempts', () => {
        const now = Date.now();
        const notBefore = getRetryNotBefore(99);
        const delayMinutes = (notBefore - now) / 1000 / 60;
        expect(Math.round(delayMinutes)).toBe(30);
    });
  });

  it('honors Retry-After when it exceeds jittered backoff', () => {
    const now = Date.parse('2026-08-08T10:00:00.000Z');
    expect(getRetryNotBefore(1, { now, random: 0.5, retryAfterMs: 300_000 })).toBe(now + 300_000);
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Sat, 08 Aug 2026 10:03:00 GMT', now)).toBe(180_000);
  });
});
