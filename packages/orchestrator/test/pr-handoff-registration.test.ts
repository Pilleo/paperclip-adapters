import { describe, expect, it } from "vitest";
import { parseJulesPrHandoffHandle, planPrHandoffRegistration } from "../src/core/pr-handoff-registration.js";

describe("PR handoff registration", () => {
  it("accepts only the complete structured Jules handoff document", () => {
    expect(parseJulesPrHandoffHandle([
      "julesSessionId: 8293350173904460926",
      "url: https://jules.google.com/session/8293350173904460926",
      "prUrl: https://github.com/Pilleo/paperclip-adapters/pull/8",
      "prHeadSha: 92843642b687cb89c6d55df4153cac560bcef5b8",
    ].join("\n"))).toEqual({
      sessionId: "8293350173904460926",
      prUrl: "https://github.com/Pilleo/paperclip-adapters/pull/8",
      headSha: "92843642b687cb89c6d55df4153cac560bcef5b8",
    });
    expect(parseJulesPrHandoffHandle("julesSessionId: 829\nprUrl: https://github.com/o/r/pull/1")).toBeNull();
  });

  it.each([
    ["registers an exact discovered green PR", { managed: true, registered: false, ciGreen: true, pr: { number: 7, url: "https://github.test/pull/7", headSha: "abc" } }, "register"],
    ["waits for CI", { managed: true, registered: false, ciGreen: false, pr: { number: 7, url: "https://github.test/pull/7", headSha: "abc" } }, "wait"],
    ["does not duplicate an existing product", { managed: true, registered: true, ciGreen: true, pr: { number: 7, url: "https://github.test/pull/7", headSha: "abc" } }, "no_action"],
    ["ignores unmanaged work", { managed: false, registered: false, ciGreen: true, pr: { number: 7, url: "https://github.test/pull/7", headSha: "abc" } }, "no_action"],
    ["does not invent a PR", { managed: true, registered: false, ciGreen: true, pr: null }, "no_action"],
  ] as const)("%s", (_name, input, action) => {
    expect(planPrHandoffRegistration(input).action).toBe(action);
  });

  it("uses immutable issue and head identity for idempotency", () => {
    expect(planPrHandoffRegistration({
      issueId: "issue-1241",
      managed: true,
      registered: false,
      ciGreen: true,
      pr: { number: 7, url: "https://github.test/pull/7", headSha: "abc" },
    })).toMatchObject({ action: "register", key: "pr-handoff:issue-1241:abc" });
  });

  it("updates the existing primary product when GitHub advances the PR head", () => {
    const decision = planPrHandoffRegistration({
      issueId: "issue-7",
      managed: true,
      registered: true,
      registeredHeadSha: "old-head",
      ciGreen: true,
      pr: { number: 7, url: "https://github.test/pull/7", headSha: "new-head" },
    } as never);

    expect(decision).toMatchObject({
      action: "update",
      key: "pr-handoff:issue-7:new-head",
      pr: { headSha: "new-head" },
    });
  });

  it("recovers a completed Jules handoff from its complete durable session handle", () => {
    expect(planPrHandoffRegistration({
      issueId: "issue-1158",
      managed: true,
      registered: false,
      ciGreen: true,
      pr: {
        number: 8,
        url: "https://github.com/Pilleo/paperclip-adapters/pull/8",
        headSha: "92843642b687cb89c6d55df4153cac560bcef5b8",
      },
      sessionHandle: {
        sessionId: "8293350173904460926",
        prUrl: "https://github.com/Pilleo/paperclip-adapters/pull/8",
        headSha: "92843642b687cb89c6d55df4153cac560bcef5b8",
      },
    })).toMatchObject({
      action: "register_from_session_handle",
      key: "pr-handoff:issue-1158:92843642b687cb89c6d55df4153cac560bcef5b8",
    });
  });

  it("records a verified red-CI handoff so Jules can remediate the existing PR", () => {
    expect(planPrHandoffRegistration({
      issueId: "issue-terminal-red-ci",
      managed: true,
      registered: false,
      ciGreen: false,
      pr: {
        number: 11,
        url: "https://github.com/Pilleo/paperclip-adapters/pull/11",
        headSha: "red-head",
      },
      sessionHandle: {
        sessionId: "terminal-session",
        prUrl: "https://github.com/Pilleo/paperclip-adapters/pull/11",
        headSha: "red-head",
      },
    })).toMatchObject({
      action: "register_from_session_handle",
      key: "pr-handoff:issue-terminal-red-ci:red-head",
    });
  });

  it("refuses a stale or incomplete session handle instead of claiming a PR", () => {
    expect(planPrHandoffRegistration({
      issueId: "issue-1158",
      managed: true,
      registered: false,
      ciGreen: true,
      pr: { number: 8, url: "https://github.com/Pilleo/paperclip-adapters/pull/8", headSha: "head-2" },
      sessionHandle: { sessionId: "8293350173904460926", prUrl: "https://github.com/Pilleo/paperclip-adapters/pull/8", headSha: "head-1" },
    } as never)).toMatchObject({ action: "refuse" });
  });
});
