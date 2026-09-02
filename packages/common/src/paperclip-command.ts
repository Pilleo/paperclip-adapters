/** A mutation with a stable identity, suitable for heartbeat retries. */
export type PaperclipCommand = {
  readonly key: string;
  readonly issueId: string;
  readonly action: "comment" | "interaction" | "status" | "assignment" | "wakeup";
  readonly payload: unknown;
};

export type PaperclipCommandResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly text?: string;
  readonly data?: unknown;
};

export type PaperclipCommandOptions = {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
};

const NO_RETRY_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

function retryable(response: PaperclipCommandResponse): boolean {
  return !response.ok && !NO_RETRY_STATUSES.has(response.status) && (response.status === 429 || response.status >= 500);
}

/**
 * Execute a Paperclip mutation with deterministic, bounded retry behavior.
 * The transport owns idempotency-key transmission; this function owns policy.
 */
export async function executePaperclipCommand(
  command: PaperclipCommand,
  run: (command: PaperclipCommand) => Promise<PaperclipCommandResponse>,
  options: PaperclipCommandOptions = {},
): Promise<PaperclipCommandResponse> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let response: PaperclipCommandResponse = { ok: false, status: 500, text: "command did not run" };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    response = await run(command);
    if (response.ok || !retryable(response) || attempt === maxAttempts) return response;
    await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
  return response;
}
