import { describe, it, expect, vi } from 'vitest';
import { cancelPaperclipInteraction, PaperclipClientError } from '../src/server/paperclip-client.js';

describe('cancelPaperclipInteraction', () => {
    it('sends PATCH to cancel interaction with correct headers and body', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        global.fetch = fetchMock as any;

        await cancelPaperclipInteraction('inter-1', 'test-token', 'test-run');

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:3100/api/interactions/inter-1',
            expect.objectContaining({
                method: 'PATCH',
                headers: expect.objectContaining({
                    'Authorization': 'Bearer test-token',
                    'Content-Type': 'application/json',
                    'X-Paperclip-Run-Id': 'test-run'
                }),
                body: JSON.stringify({ status: 'cancelled' })
            })
        );
    });

    it('throws PaperclipClientError on failed cancellation', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'Internal Error' });
        global.fetch = fetchMock as any;

        await expect(cancelPaperclipInteraction('inter-1', 'test-token', 'test-run'))
            .rejects.toThrow(PaperclipClientError);
    });
});
