/**
 * Paperclip's executionBlocker is a server-owned no-replay boundary. Its
 * internal causes may evolve independently of external adapters, so every
 * non-null projection is held fail-closed until Paperclip removes it. An
 * adapter may resolve a typed recovery action, but only the server-owned
 * continuation wake is allowed to consume that reconciliation.
 */
export function isExecutionAdmissionHeld(rawIssue: Readonly<Record<string, unknown>>): boolean {
  return rawIssue["executionBlocker"] !== null && rawIssue["executionBlocker"] !== undefined;
}
