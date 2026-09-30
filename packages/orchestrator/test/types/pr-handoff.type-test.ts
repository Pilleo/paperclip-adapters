import type { JulesPrHandoffEvidence, VerifiedTerminalPrHandoff } from "../../src/core/jules-monitor-state.js";

// @ts-expect-error A terminal handoff label without validated identity evidence cannot authorize review.
const bare: JulesPrHandoffEvidence = { kind: "terminal_pr_handoff" };
void bare;

declare const proof: VerifiedTerminalPrHandoff;
// @ts-expect-error Validated evidence cannot be copied to authorize another head.
const changedHead: VerifiedTerminalPrHandoff = { ...proof, headSha: "another-head" };
void changedHead;
