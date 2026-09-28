import { describe, expect, it } from "vitest";
import { decideProviderCreateRecovery } from "../src/server/provider-create-reconciliation.js";
import { sessionCodec } from "../src/server/session.js";

const intent = { requestId: "request-1", runId: "run-1", promptSha256: "a".repeat(64),
  source: "sources/github/acme/repo", baseBranch: "master", startedAt: "2026-09-27T01:00:00Z" };
const matching = { id: "session-1", promptSha256: intent.promptSha256, source: intent.source, baseBranch: intent.baseBranch,
  createdAt: "2026-09-27T01:00:01Z" };

describe("reconcile ambiguous Jules create POST without replaying it", () => {
  it("reattaches only the one session with the exact prompt, source and branch", () => {
    expect(decideProviderCreateRecovery(intent, [matching], true)).toEqual({ kind: "reattach", sessionId: "session-1" });
    expect(decideProviderCreateRecovery(intent, [{ ...matching, baseBranch: "feature" }], true).kind).toBe("hold");
  });

  it("fails closed for absent, ambiguous or incompletely paginated sessions", () => {
    expect(decideProviderCreateRecovery(intent, [], true).kind).toBe("hold");
    expect(decideProviderCreateRecovery(intent, [matching, { ...matching, id: "session-2" }], true).kind).toBe("hold");
    expect(decideProviderCreateRecovery(intent, [matching], false).kind).toBe("hold");
  });
  it("persists an outstanding create intent through the durable session codec", () => {
    const encoded = sessionCodec.encode({ version: 1, paperclipIssueId: "issue-1", promptHash: "hash",
      repository: "acme/repo", source: intent.source, baseBranch: intent.baseBranch, phase: "STARTING",
      attempt: 1, failedSessions: [], createdAt: intent.startedAt, providerCreateIntent: intent,
    } as never);
    expect(sessionCodec.decode(encoded)?.providerCreateIntent).toMatchObject(intent);
  });
});
