import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testEnvironment } from '../src/server/test-environment';
import { JulesClient } from '../src/server/jules-client';
import { AdapterEnvironmentTestContext } from '@paperclipai/adapter-utils';

vi.mock('../src/server/jules-client');

  describe('testEnvironment', () => {
    const baseCtx: AdapterEnvironmentTestContext = {
        companyId: 'test',
        adapterType: 'jules',
        config: {
            source: 'sources/github/acme/repo', repository: 'acme/repo', baseBranch: 'main',
            pollIntervalSeconds: 10, heartbeatPollWindowSeconds: 30,
            env: { JULES_API_KEY: 'test-key' },

        }
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns pass status correctly on success validation', async () => {
        (JulesClient.prototype.listSessions as any).mockResolvedValueOnce({ sessions: [] });
        const res = await testEnvironment(baseCtx);
        expect(res.status).toBe('pass');
    });

    it('returns fail status correctly on bad config', async () => {
        const res = await testEnvironment({ config: {} } as any);
        expect(res.status).toBe('fail');
        expect(res.checks[0]!.code).toBe('config_validation_failed');
    });

    it('fails with binding guidance even if the server environment has a key', async () => {
        const prior = process.env['JULES_API_KEY'];
        process.env['JULES_API_KEY'] = 'server-only-key';
        const res = await testEnvironment({ ...baseCtx, config: { repository: 'acme/repo', baseBranch: 'main' } });
        expect(res.status).toBe('fail');
        expect(res.checks[0]!.message).toContain('env.JULES_API_KEY');
        if (prior === undefined) delete process.env['JULES_API_KEY'];
        else process.env['JULES_API_KEY'] = prior;
    });

    it('returns fail status correctly on auth errors', async () => {
        (JulesClient.prototype.listSessions as any).mockRejectedValueOnce({ status: 401 });
        const res = await testEnvironment(baseCtx);
        expect(res.status).toBe('fail');
        expect(res.checks[0]!.code).toBe('jules_credentials_invalid');
    });

    it('returns fail status correctly on unrecoverable general api errors', async () => {
        (JulesClient.prototype.listSessions as any).mockRejectedValueOnce(new Error('Down'));
        const res = await testEnvironment(baseCtx);
        expect(res.status).toBe('fail');
        expect(res.checks[0]!.code).toBe('jules_api_unavailable');
    });
});
