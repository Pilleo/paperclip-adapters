/** Remote Jules states that must be reattached, never replaced with createSession. */
export const LIVE_JULES_REMOTE_STATES = Object.freeze([
  "QUEUED",
  "PLANNING",
  "IN_PROGRESS",
  "AWAITING_USER_FEEDBACK",
  "AWAITING_PLAN_APPROVAL",
]);

export function isLiveJulesRemoteState(state: string | null | undefined): boolean {
  if (!state) return false;
  const upper = state.toUpperCase();
  return (LIVE_JULES_REMOTE_STATES as readonly string[]).includes(upper);
}
