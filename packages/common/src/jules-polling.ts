/**
 * Jules is an asynchronous cloud worker: a normal implementation phase often
 * lasts tens of minutes. This is deliberately not the cadence for local ACP
 * workers or event-driven review agents.
 *
 * Keep every adapter-owned Jules monitor on this one value. A shorter fallback
 * creates needless provider traffic and noisy Paperclip activity; explicit
 * provider events still wake the owner immediately.
 */
export const JULES_PROVIDER_POLL_CADENCE_SECONDS = 15 * 60;
export const JULES_PROVIDER_POLL_CADENCE_MS = JULES_PROVIDER_POLL_CADENCE_SECONDS * 1_000;
