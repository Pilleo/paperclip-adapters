import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getRetryNotBefore } from '../src/server/retry-policy';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('getRetryNotBefore bounds', () => {
   it('caps maximum retry delay correctly on large attempts', () => {
       const now = Date.now();
       const notBefore = getRetryNotBefore(99);
       const delayMinutes = (notBefore - now) / 1000 / 60;
       expect(Math.round(delayMinutes)).toBe(30);
   });
});
