import { describe, expect, it } from "vitest";
import { stressPilotTasks, stressTasks } from "../src/core/stress-campaign-manifest.js";
import { evaluateStressProgress, type StressIssueEvidence } from "../src/core/stress-campaign-progress.js";

const tasks = stressTasks("stress-20260929-a");
const sha = (key: string) => key.repeat(20);
const issues = (): StressIssueEvidence[] => tasks.map((task) => ({
  key: task.key, id: `issue-${task.key}`, status: "todo", assigneeAgentId: null, executionRunId: null,
  blockedBy: task.predecessors.map((key) => `issue-${key}`), startApproval: "pending",
  executionBlocker: null, product: null, github: null, planReviews: [], prReviews: [],
}));
const complete = (): StressIssueEvidence[] => issues().map((issue) => ({
  ...issue, status: "done", startApproval: "approved", providerSessionId: `session-${issue.key}`,
  startedAt: `2026-09-29T12:${issue.key}:00Z`,
  product: { url: `https://github.com/Pilleo/test/pull/${Number(issue.key)}`, headSha: sha(issue.key), status: "merged" },
  github: { state: "MERGED", headSha: sha(issue.key), mergedAt: `2026-09-29T12:${issue.key}:30Z`,
    parents: ["a".repeat(40), sha(issue.key)] },
  planReviews: ["luna", "terra"].map((stage) => ({ stage, sessionId: `session-${issue.key}`, verdict: "approve", runStatus: "succeeded" })),
  prReviews: ["luna", "strong"].map((stage) => ({ stage, headSha: sha(issue.key), verdict: "approve", runStatus: "succeeded" })),
}));

describe("read-only 20-task stress acceptance", () => {
  it("accepts exactly two independently approved and merged pilot roots without weakening the full-run cardinality", () => {
    const pilot = stressPilotTasks("stress-20260929-a");
    const initial = issues().filter((issue) => issue.key === "03" || issue.key === "04");
    const finished = complete().filter((issue) => issue.key === "03" || issue.key === "04");
    expect(evaluateStressProgress(pilot, initial).kind).toBe("awaiting_user_start");
    expect(evaluateStressProgress(pilot, finished).kind).toBe("passed");
    expect(evaluateStressProgress(tasks, finished).kind).toBe("invalid");
  });
  it("distinguishes user start/merge waits, provider progress and the complete proof", () => {
    expect(evaluateStressProgress(tasks, issues()).kind).toBe("awaiting_user_start");
    const working = issues().map((issue) => ({ ...issue, startApproval: "approved" }));
    expect(evaluateStressProgress(tasks, working).kind).toBe("awaiting_provider");
    const done = complete();
    expect(evaluateStressProgress(tasks, done).kind).toBe("passed");
    const open = done.map((issue) => issue.key === "10" ? { ...issue, status: "in_review", mergeApproval: "pending", product: { ...issue.product!, status: "ready_for_review" },
      github: { ...issue.github!, state: "OPEN", mergedAt: null, parents: [] } } : issue);
    expect(evaluateStressProgress(tasks, open).kind).toBe("awaiting_user_merge");
  });

  it("rejects early dependent work and concurrent shared-file work", () => {
    const early = issues();
    early[6] = { ...early[6]!, status: "in_progress", assigneeAgentId: "jules" };
    expect(evaluateStressProgress(tasks, early).kind).toBe("invalid");
    const overlap = issues();
    overlap[2] = { ...overlap[2]!, status: "in_progress", startApproval: "approved" };
    overlap[3] = { ...overlap[3]!, status: "in_progress", startApproval: "approved" };
    expect(evaluateStressProgress(tasks, overlap)).toEqual({ kind: "invalid", reason: "shared_03_04_overlap" });
  });

  it("fails closed on missing GitHub merge ancestry, wrong reviewer head, duplicate sessions and terminal blockers", () => {
    const head = complete();
    head[0] = { ...head[0]!, github: { ...head[0]!.github!, parents: ["a".repeat(40), "b".repeat(40)] } };
    expect(evaluateStressProgress(tasks, head).kind).toBe("invalid");
    const review = complete();
    review[0] = { ...review[0]!, prReviews: [{ ...review[0]!.prReviews[0]!, headSha: "b".repeat(40) }, review[0]!.prReviews[1]!] };
    expect(evaluateStressProgress(tasks, review).kind).toBe("invalid");
    const stale = complete();
    stale[0] = { ...stale[0]!, github: { ...stale[0]!.github!, headSha: "b".repeat(40) } };
    expect(evaluateStressProgress(tasks, stale)).toEqual({ kind: "invalid", reason: "01_stale_pr_head_verdict" });
    const session = complete();
    session[1] = { ...session[1]!, providerSessionId: session[0]!.providerSessionId };
    expect(evaluateStressProgress(tasks, session).kind).toBe("invalid");
    const blocker = complete();
    blocker[0] = { ...blocker[0]!, executionBlocker: "old-failed-run" };
    expect(evaluateStressProgress(tasks, blocker).kind).toBe("invalid");
  });
});
