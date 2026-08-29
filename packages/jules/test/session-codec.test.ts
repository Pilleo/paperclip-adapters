import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sessionCodec } from '../src/server/session';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('Session Codec', () => {
    it.each([
      [null],
      [undefined],
      [{}],
    ])("treats %p as no persisted session", (raw) => {
      expect(sessionCodec.deserialize(raw)).toBeNull();
      expect(sessionCodec.decode(raw)).toBeNull();
    });

    it('rejects malformed non-empty persisted sessions', () => {
        expect(sessionCodec.decode({ version: 1, paperclipIssueId: 'issue-1' })).toBeNull();
        expect(sessionCodec.deserialize({ version: 1, paperclipIssueId: 'issue-1' })).toBeNull();
        expect(sessionCodec.serialize({ version: 1, paperclipIssueId: 'issue-1' } as any)).toBeNull();
    });

    it('successfully decodes a valid session state', () => {
        const payload = {
            version: 1,
            paperclipIssueId: 'i',
            promptHash: 'h',
            repository: 'r',
            source: 's',
            baseBranch: 'b',
            phase: 'RUNNING',
            sessionId: 'j-1',
            julesSessionId: 'j-1',
            attempt: 1,
            failedSessions: [],
            createdAt: '2020'
        };
        const res = sessionCodec.decode(payload);
        expect(res).toBeDefined();
        expect(res!.phase).toBe('RUNNING');
    });

    it('successfully extracts display id from encoded structure', () => {
        const payload = {
            version: 1,
            paperclipIssueId: 'i',
            promptHash: 'h',
            repository: 'r',
            source: 's',
            baseBranch: 'b',
            phase: 'RUNNING',
            sessionId: 'j-1',
            attempt: 1,
            failedSessions: [],
            createdAt: '2020',
            julesSessionId: 'j-1'
        };
        expect(sessionCodec.getDisplayId(payload)).toBe('j-1');
        expect(sessionCodec.getDisplayId(null)).toBeNull();
    });

    it('preserves canonical identity when Paperclip metadata is attached', () => {
        const persisted = {
            version: 1,
            paperclipIssueId: 'i',
            promptHash: 'h',
            repository: 'r',
            source: 's',
            baseBranch: 'b',
            phase: 'RUNNING',
            sessionId: 'j-1',
            julesSessionId: 'j-1',
            attempt: 1,
            failedSessions: [],
            createdAt: '2020',
            __paperclip: { model: 'test-model' }
        };

        expect(sessionCodec.deserialize(persisted)).toMatchObject({
            sessionId: 'j-1',
            julesSessionId: 'j-1'
        });
    });

    it('round-trips Paperclip canonical-only resume state', () => {
        const resumeState = { sessionId: 'session-123' };

        expect(sessionCodec.deserialize(resumeState)).toEqual(resumeState);
        expect(sessionCodec.serialize(resumeState)).toEqual(resumeState);
        expect(sessionCodec.getDisplayId(resumeState)).toBe('session-123');
        expect(sessionCodec.getCanonicalSessionId(resumeState)).toBe('session-123');
    });

    it('rejects active legacy sessions without the canonical sessionId', () => {
        expect(sessionCodec.decode({
            version: 1,
            paperclipIssueId: 'i',
            promptHash: 'h',
            repository: 'r',
            source: 's',
            baseBranch: 'b',
            phase: 'RUNNING',
            julesSessionId: 'j-1',
            attempt: 1,
            failedSessions: [],
            createdAt: '2020'
        })).toBeNull();
    });

    it('round-trips completion confirmation and prompt hash metadata', () => {
        const payload = {
            version: 1,
            paperclipIssueId: 'issue-1',
            promptHash: 'identity-hash',
            promptHashVersion: 2,
            repository: 'r',
            source: 's',
            baseBranch: 'main',
            phase: 'COMPLETED',
            sessionId: 'j-1',
            julesSessionId: 'j-1',
            julesSessionUrl: 'https://jules.google.com/session/j-1',
            attempt: 1,
            failedSessions: [],
            pendingInteraction: {
                type: 'completion_confirmation',
                paperclipInteractionId: 'interaction-1',
                question: 'Is this complete?',
                createdAt: '2026-08-07T00:00:00.000Z'
            },
            createdAt: '2026-08-07T00:00:00.000Z'
        };

        expect(sessionCodec.decode(sessionCodec.serialize(payload))).toMatchObject(payload);
    });

    it('round-trips delivered Jules activity identifiers', () => {
        const payload = {
            version: 1,
            paperclipIssueId: 'issue-1',
            promptHash: 'identity-hash',
            repository: 'r',
            source: 's',
            baseBranch: 'main',
            phase: 'RUNNING',
            sessionId: 'j-1',
            julesSessionId: 'j-1',
            attempt: 1,
            failedSessions: [],
            deliveredActivityIds: ['activity-1', 'activity-2'],
            createdAt: '2026-08-07T00:00:00.000Z'
        };

        expect(sessionCodec.decode(sessionCodec.serialize(payload))).toMatchObject(payload);
    });
});
describe('Session Codec serialization coverage', () => {
   it('correctly maps null outputs for encode and serialize boundaries', () => {
      expect(sessionCodec.serialize(null)).toBeNull();
   });
});
