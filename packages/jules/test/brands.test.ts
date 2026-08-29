import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { asPaperclipId, asJulesSessionId, asJulesSessionName, asJulesActivityId, asPrUrl, parseJulesSessionName } from '../src/server/brands';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('Brands Coverage', () => {
    it('throws appropriately on invalid branded ids', () => {
        expect(() => asPaperclipId('')).toThrow('Invalid PaperclipId');
        expect(() => asJulesSessionId('')).toThrow('Invalid JulesSessionId');
        expect(() => asJulesSessionName('')).toThrow('Invalid JulesSessionName');
        expect(() => parseJulesSessionName('')).toThrow('Invalid JulesSessionName');
        expect(() => asJulesActivityId('')).toThrow('Invalid JulesActivityId');
        expect(() => asPrUrl('not-http')).toThrow('Invalid PrUrl');
    });

    it('creates branded ids validly', () => {
        expect(asPaperclipId('valid')).toBe('valid');
        expect(asJulesSessionId('valid')).toBe('valid');
        expect(asJulesSessionName('valid')).toBe('valid');
        expect(asJulesActivityId('valid')).toBe('valid');
        expect(asPrUrl('http://valid')).toBe('http://valid');
    });
});
