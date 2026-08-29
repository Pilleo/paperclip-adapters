import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sessionCodec, JulesAdapterSessionV1 } from '../src/server/session';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('sessionCodec', () => {
  const validSession: JulesAdapterSessionV1 = {
    version: 1,
    paperclipIssueId: 'issue-123',
    promptHash: 'hash-abc',
    repository: 'Pilleo/paperclip-jules-adapter',
    source: 'github',
    baseBranch: 'master',
    phase: 'RUNNING',
    sessionId: 'sess-456',
    julesSessionId: 'sess-456',
    attempt: 1,
    failedSessions: [],
    createdAt: new Date().toISOString()
  };

  it('decodes a valid session correctly', () => {
    const decoded = sessionCodec.decode(validSession);
    expect(decoded).toEqual(validSession);
  });

  it('encodes a valid session correctly', () => {
    const encoded = sessionCodec.encode(validSession);
    expect(encoded).toEqual(validSession);
  });

  it('treats invalid version as empty persisted state', () => {
    const invalidSession = { ...validSession, version: 2 };
    expect(sessionCodec.decode(invalidSession)).toBeNull();
  });

  it('treats malformed session data as empty persisted state', () => {
    const malformedSession = { ...validSession, attempt: -1 };
    expect(sessionCodec.decode(malformedSession)).toBeNull();
  });

  it('returns display id', () => {
    expect(sessionCodec.getDisplayId(validSession)).toBe('sess-456');
  });

  it('preserves unknown Jules state safely', () => {
     const sessionWithUnknownState = { ...validSession, julesState: 'SOME_WEIRD_STATE_XYZ' };
     const decoded = sessionCodec.decode(sessionWithUnknownState);
     expect(decoded.julesState).toBe('SOME_WEIRD_STATE_XYZ');
  });
});
