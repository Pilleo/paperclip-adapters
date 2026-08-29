import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execute } from '../src/server/execute';
import { JulesClient } from '../src/server/jules-client';
import { sessionCodec } from '../src/server/session';

vi.mock('../src/server/jules-client');

  describe('Required Edge Cases Tests', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (JulesClient.prototype.listSessions as any).mockResolvedValue({ sessions: [] });
        (JulesClient.prototype.getActivities as any).mockResolvedValue({ activities: [] });
    });

    it('handles malformed host context safely', async () => {
       const badCtx = {} as any;
       await expect(execute(badCtx)).rejects.toThrow();
    });

    it('handles malformed jules payloads safely via api schema throws', async () => {
       const baseCtx = {
         agent: { adapterConfig: { source: 's', repository: 'r' } },
         config: { env: { JULES_API_KEY: 'test-key' } },
         context: { secrets: { JULES_API_KEY: 'k' }, task: { id: 't', title: 'test task' } },
         runtime: {},
         runId: 'r'
       } as any;

       (JulesClient.prototype.createSession as any).mockRejectedValueOnce(new Error('Invalid payload validation'));
       const res = await execute(baseCtx);
       expect(res.exitCode).toBe(1);
    });

    it('handles unknown state successfully mapping to RUNNING loop', async () => {
       const baseCtx = {
         agent: { adapterConfig: { source: 's', repository: 'r' } },
         config: { env: { JULES_API_KEY: 'test-key' } },
         context: { secrets: { JULES_API_KEY: 'k' }, task: { id: 't', title: 'test task' } },
         runtime: {
           sessionParams: sessionCodec.encode({
             version: 1,
             paperclipIssueId: 't',
             promptHash: 'hash',
             repository: 'r',
             source: 's',
             baseBranch: 'master',
             phase: 'RUNNING',
             sessionId: '123',
             julesSessionId: '123',
             attempt: 1,
             failedSessions: [],
             createdAt: new Date().toISOString()
           } as any)
         },
         runId: 'r'
       } as any;

       (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ id: '123', name: 'sessions/123', state: 'NEW_UNSEEN_STATE' });

       const abortCtrl = new AbortController();
       setTimeout(() => abortCtrl.abort(), 10);

       const res = await execute({ ...baseCtx, abortSignal: abortCtrl.signal } as any);
       expect(res.exitCode).toBe(0);
       // pending checkpoint has exitCode 0
       const decoded = sessionCodec.decode(res.sessionParams!);
       expect(decoded.phase).toBe('RUNNING');
    });

    it('rejects active session state without both canonical and Jules IDs', () => {
       expect(() => sessionCodec.encode({
           version: 1,
           paperclipIssueId: 't',
           promptHash: 'some-hash',
           repository: 'r',
           source: 's',
           baseBranch: 'master',
           phase: 'RUNNING',
           julesSessionId: undefined, // Absent session id
           attempt: 1,
           failedSessions: [],
           createdAt: new Date().toISOString()
       } as any)).toThrow("Active Jules sessions require equal sessionId and julesSessionId");
    });
});
