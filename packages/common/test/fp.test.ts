import { describe, it, expect } from "vitest";
import {
  ok,
  err,
  isOk,
  isErr,
  mapResult,
  flatMapResult,
  unwrapOr,
  matchResult,
  some,
  none,
  fromNullable,
  mapOption,
  unwrapOptionOr,
  assertNever,
  createStateMachine,
} from "../src/fp.js";
import {
  asIssueId,
  asCompanyId,
  asAgentId,
  asPrNumber,
  asPrUrl,
  asCommitSha,
  asBranchName,
} from "../src/domain-brands.js";

describe("Functional Programming & Type Safety Toolkit", () => {
  it("handles Result monad with map and flatMap", () => {
    const success = ok<number>(10);
    const doubled = mapResult(success, (x) => x * 2);
    expect(isOk(doubled)).toBe(true);
    expect(unwrapOr(doubled, 0)).toBe(20);

    const chained = flatMapResult(doubled, (x) => ok(`Value: ${x}`));
    expect(unwrapOr(chained, "")).toBe("Value: 20");

    const failure = err<string>("Something went wrong");
    expect(isErr(failure)).toBe(true);
    const handled = matchResult(failure, {
      onOk: (val) => `OK: ${val}`,
      onErr: (e) => `ERR: ${e}`,
    });
    expect(handled).toBe("ERR: Something went wrong");
  });

  it("handles Option monad with fromNullable and map", () => {
    const optSome = fromNullable("hello");
    expect(optSome.some).toBe(true);
    const mapped = mapOption(optSome, (s) => s.toUpperCase());
    expect(unwrapOptionOr(mapped, "")).toBe("HELLO");

    const optNone = fromNullable(null);
    expect(optNone.some).toBe(false);
    expect(unwrapOptionOr(optNone, "fallback")).toBe("fallback");
  });

  it("enforces pure state machine transitions", () => {
    type State = { status: "idle" } | { status: "running"; taskId: string } | { status: "done" };
    type Event = { type: "START"; taskId: string } | { type: "FINISH" };

    const sm = createStateMachine<State, Event>({ status: "idle" }, (state, event) => {
      switch (event.type) {
        case "START":
          return { status: "running", taskId: event.taskId };
        case "FINISH":
          return { status: "done" };
        default:
          return assertNever(event);
      }
    });

    expect(sm.initialState.status).toBe("idle");
    const s1 = sm.transition(sm.initialState, { type: "START", taskId: "MAZ-100" });
    expect(s1.status).toBe("running");
    const s2 = sm.transition(s1, { type: "FINISH" });
    expect(s2.status).toBe("done");
  });

  it("validates branded domain types via smart constructors", () => {
    const issueId = asIssueId("issue-123");
    expect(issueId).toBe("issue-123");
    expect(() => asIssueId("")).toThrow("Invalid IssueId");

    const companyId = asCompanyId("comp-456");
    expect(companyId).toBe("comp-456");

    const agentId = asAgentId("agent-789");
    expect(agentId).toBe("agent-789");

    const prNumber = asPrNumber(42);
    expect(prNumber).toBe(42);
    expect(() => asPrNumber(-1)).toThrow("Invalid PrNumber");

    const prUrl = asPrUrl("https://github.com/org/repo/pull/1");
    expect(prUrl).toContain("https://");

    const commitSha = asCommitSha("a1b2c3d4e5f67890123456789012345678901234");
    expect(commitSha).toHaveLength(40);
    expect(() => asCommitSha("invalid!sha")).toThrow("Invalid CommitSha");

    const branch = asBranchName("feature/landlock-v5");
    expect(branch).toBe("feature/landlock-v5");
  });
});
