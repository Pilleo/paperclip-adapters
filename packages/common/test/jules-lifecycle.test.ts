import { describe, expect, it } from "vitest";
import {
  reduceJulesLifecycle,
  type JulesLifecycleEvent,
  type JulesLifecycleState,
} from "../src/jules-lifecycle.js";

const baseState: JulesLifecycleState = {
  provider: { kind: "awaiting_plan", sessionId: "session-1", revisionId: "rev-1" },
  review: { kind: "none" },
  effect: { kind: "not_started" },
  monitor: { kind: "scheduled", monitorId: "monitor-1" },
};

describe("Jules lifecycle reducer", () => {
  it.each<readonly [string, JulesLifecycleState, JulesLifecycleEvent, string]>([
    [
      "creates the first Luna card for an unreviewed plan",
      baseState,
      { kind: "heartbeat" },
      "create_card",
    ],
    [
      "preserves a pending exact card on a duplicate heartbeat",
      {
        ...baseState,
        review: { kind: "pending", cardId: "card-1", revisionId: "rev-1", reviewer: "luna" },
      },
      { kind: "heartbeat" },
      "preserve",
    ],
    [
      "reconciles an uncertain provider mutation after interruption",
      {
        ...baseState,
        provider: { kind: "awaiting_feedback", sessionId: "session-1", revisionId: "rev-1" },
        review: {
          kind: "resolved",
          cardId: "card-1",
          revisionId: "rev-1",
          reviewer: "luna",
          verdict: "reject",
          runId: "run-luna-1",
        },
        effect: { kind: "started", effectId: "deliver:card-1", startedAt: "2026-09-20T00:00:00.000Z" },
      },
      { kind: "run_interrupted" },
      "reconcile_effect",
    ],
    [
      "rearms the provider monitor when interruption happened before any effect",
      {
        ...baseState,
        provider: { kind: "in_progress", sessionId: "session-1" },
        monitor: { kind: "triggered", monitorId: "monitor-1" },
      },
      { kind: "run_interrupted" },
      "rearm_monitor",
    ],
    [
      "ignores a stale verdict for an earlier revision",
      baseState,
      {
        kind: "review_card_resolved",
        cardId: "card-old",
        revisionId: "rev-old",
        reviewer: "luna",
        verdict: "approve",
        runId: "run-old",
      },
      "preserve",
    ],
    [
      "completes a terminal provider session exactly once",
      {
        ...baseState,
        provider: { kind: "completed", sessionId: "session-1", pullRequestUrl: "https://github.com/example/repo/pull/1" },
        monitor: { kind: "none" },
      },
      { kind: "heartbeat" },
      "complete_issue",
    ],
  ])("%s", (_name, state, event, expectedEffect) => {
    const decision = reduceJulesLifecycle(state, event);
    expect(decision.effect.kind).toBe(expectedEffect);
  });

  it.each<readonly [string, JulesLifecycleState, unknown]>([
    [
      "creates the Terra card after Luna approves the exact plan revision",
      {
        ...baseState,
        review: { kind: "resolved", cardId: "card-luna", revisionId: "rev-1", reviewer: "luna", verdict: "approve", runId: "run-luna-1" },
      },
      { kind: "create_card", reviewer: "terra", revisionId: "rev-1" },
    ],
    [
      "uses typed provider approval only after Terra approves the exact plan revision",
      {
        ...baseState,
        review: { kind: "resolved", cardId: "card-terra", revisionId: "rev-1", reviewer: "terra", verdict: "approve", runId: "run-terra-1" },
      },
      { kind: "approve_plan", sessionId: "session-1", revisionId: "rev-1" },
    ],
    [
      "requests a fresh plan revision after either native reviewer rejects",
      {
        ...baseState,
        review: { kind: "resolved", cardId: "card-luna", revisionId: "rev-1", reviewer: "luna", verdict: "reject", runId: "run-luna-1" },
      },
      { kind: "request_plan_revision", cardId: "card-luna", revisionId: "rev-1", reviewer: "luna", runId: "run-luna-1" },
    ],
  ])("%s", (_name, state, expected) => {
    expect(reduceJulesLifecycle(state, { kind: "heartbeat" }).effect).toEqual(expected);
  });
});
