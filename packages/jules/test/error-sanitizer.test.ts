import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sanitizeError } from '../src/server/error-sanitizer';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('sanitizeError', () => {
    it('truncates long messages', () => {
        const longMsg = "a".repeat(1000);
        const result = sanitizeError(longMsg, { maxLen: 10 });
        expect(result).toBe("aaaaaaaaaa... (truncated)");
        expect(result.length).toBeLessThan(50);
    });

    it('redacts potential secrets', () => {
        const msg = "Failed due to invalid key=abcdefghijklmnopqrstuvwxyz123";
        const result = sanitizeError(msg);
        expect(result).toBe("Failed due to invalid key=***REDACTED***");
    });

    it('handles non-error objects safely', () => {
       expect(sanitizeError({ a: 1 })).toBe('{"a":1}');
       expect(sanitizeError(null)).toBe('Unknown error');
    });
});
