import type { JulesAdapterSessionV1 } from "../../src/server/session.js";
import type { SessionStartupDecision } from "../../src/server/session-lifecycle.js";

declare const session: JulesAdapterSessionV1;

const resumed: SessionStartupDecision = { action: "RESUME_EXISTING", forceFreshSession: false,
  isInteractionResume: false, session, reason: "Existing provider session" };
const fresh: SessionStartupDecision = { action: "START_FRESH", forceFreshSession: false,
  isInteractionResume: false, session: null, reason: "Initial creation" };
void resumed;
void fresh;

// @ts-expect-error A fresh create must not carry a second existing provider session.
const freshWithSession: SessionStartupDecision = { action: "START_FRESH", forceFreshSession: true,
  isInteractionResume: false, session, reason: "Invalid" };
// @ts-expect-error Resume requires a durable attached provider session.
const resumeWithoutSession: SessionStartupDecision = { action: "RESUME_EXISTING", forceFreshSession: false,
  isInteractionResume: false, session: null, reason: "Invalid" };
// @ts-expect-error Relaying an interaction must be a typed interaction wake.
const relayWithoutInteraction: SessionStartupDecision = { action: "RELAY_INTERACTION", forceFreshSession: false,
  isInteractionResume: false, session, reason: "Invalid" };
// @ts-expect-error The startup evaluator never returns an unhandled NO_OP state.
const noop: SessionStartupDecision = { action: "NO_OP", forceFreshSession: false,
  isInteractionResume: false, session: null, reason: "Invalid" };
void freshWithSession;
void resumeWithoutSession;
void relayWithoutInteraction;
void noop;
