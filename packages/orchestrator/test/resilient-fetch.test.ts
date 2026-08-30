import { describe, it, expect, vi } from "vitest";
import { resilientFetch } from "../src/core/resilient-fetch.js";

describe("Resilient Paperclip Fetch Client", () => {
  it("succeeds on first attempt when response is ok", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });

    const res = await resilientFetch("http://127.0.0.1:3100/api/health", {}, {
      fetchFn: mockFetch,
      maxRetries: 3,
      baseDelayMs: 10,
    });

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 500 server error and succeeds on subsequent attempt", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });

    const res = await resilientFetch("http://127.0.0.1:3100/api/issues", {}, {
      fetchFn: mockFetch,
      maxRetries: 3,
      baseDelayMs: 10,
    });

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("fails after max retries are exhausted", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Connection reset by peer"));

    await expect(
      resilientFetch("http://127.0.0.1:3100/api/issues", {}, {
        fetchFn: mockFetch,
        maxRetries: 2,
        baseDelayMs: 10,
      })
    ).rejects.toThrow("Connection reset by peer");

    expect(mockFetch).toHaveBeenCalledTimes(3); // Initial + 2 retries
  });
});
