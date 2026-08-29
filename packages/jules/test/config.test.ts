import { describe, it, expect } from 'vitest';
import { validateConfig, requireJulesApiKey, AdapterConfigSchema } from '../src/server/config';
import { julesConfigSchema } from '../src/server/config-schema';

describe('Config', () => {
  it('validateConfig throws if source is missing', () => {
    expect(() => validateConfig({ repository: 'a' })).toThrow();
  });

  it('requireJulesApiKey throws if the Paperclip binding is missing', () => {
     expect(() => requireJulesApiKey({})).toThrow('JULES_API_KEY did not resolve');
  expect(() => requireJulesApiKey({})).toThrow('secret_ref');
  });

  it('requireJulesApiKey reads the resolved Paperclip binding', () => {
      const res = requireJulesApiKey({ env: { JULES_API_KEY: ' test ' } });
      expect(res).toBe('test');
  });

  it('requireJulesApiKey ignores the server process environment', () => {
      const prior = process.env['JULES_API_KEY'];
      process.env['JULES_API_KEY'] = 'server-only-key';
      expect(() => requireJulesApiKey({ env: {} })).toThrow('JULES_API_KEY did not resolve');
      if (prior === undefined) delete process.env['JULES_API_KEY'];
      else process.env['JULES_API_KEY'] = prior;
  });

  it('declarative defaults satisfy runtime validation (no drift)', () => {
    const defaults = Object.fromEntries(
        julesConfigSchema.fields
          .filter(field => field.default !== undefined)
          .map(field => [field.key, field.default])
    );
    const result = AdapterConfigSchema.safeParse({
        ...defaults,
        source: 'sources/github/org/repo',
        repository: 'org/repo'
    });
    expect(result.success).toBe(true);
  });

  it('does not expose timing controls for Jules long-polling', () => {
    const keys = julesConfigSchema.fields.map(field => field.key);
    expect(keys).not.toContain('pollIntervalMinutes');
    expect(keys).not.toContain('heartbeatPollWindowMinutes');
    expect(keys).not.toContain('pollIntervalSeconds');
    expect(keys).not.toContain('heartbeatPollWindowSeconds');
  });

  it('continues to accept existing timing settings during migration', () => {
    const result = validateConfig({
      source: 'sources/github/org/repo',
      repository: 'org/repo',
      pollIntervalSeconds: 45,
      heartbeatPollWindowSeconds: 120,
    });

    expect(result.pollIntervalSeconds).toBe(45);
    expect(result.heartbeatPollWindowSeconds).toBe(120);
  });
});
