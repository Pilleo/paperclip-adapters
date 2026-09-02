import { describe, expect, it, vi } from "vitest";
import { executePaperclipCommand, type PaperclipCommandResponse } from "../src/paperclip-command.js";

const command = { key: "comment:issue-1:activity-1", action: "comment" as const, issueId: "issue-1", payload: { body: "hello" } };

describe("Paperclip command executor", () => {
  it("executes a command once and returns the response", async () => {
    const run = vi.fn(async (): Promise<PaperclipCommandResponse> => ({ ok: true, status: 201, data: { id: "comment-1" } }));
    await expect(executePaperclipCommand(command, run)).resolves.toEqual({ ok: true, status: 201, data: { id: "comment-1" } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures with bounded backoff", async () => {
    const responses: PaperclipCommandResponse[] = [
      { ok: false, status: 503, text: "unavailable" },
      { ok: false, status: 429, text: "slow down" },
      { ok: true, status: 200, data: { id: "wake-1" } },
    ];
    const run = vi.fn(async () => responses.shift()!);
    const sleep = vi.fn(async () => undefined);
    await expect(executePaperclipCommand({ ...command, action: "wakeup" }, run, { maxAttempts: 3, sleep })).resolves.toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 409])("does not retry permanent/conflict status %s", async (status) => {
    const run = vi.fn(async () => ({ ok: false, status, text: "rejected" } satisfies PaperclipCommandResponse));
    await expect(executePaperclipCommand(command, run, { sleep: vi.fn(async () => undefined) })).resolves.toMatchObject({ status });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not retry after the attempt budget is exhausted", async () => {
    const run = vi.fn(async () => ({ ok: false, status: 500, text: "failed" } satisfies PaperclipCommandResponse));
    await executePaperclipCommand(command, run, { maxAttempts: 2, sleep: vi.fn(async () => undefined) });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
