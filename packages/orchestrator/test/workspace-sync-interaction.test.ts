import { describe, expect, it } from "vitest";
import { buildWorkspaceSyncInteractionRequest, planWorkspaceSyncInteraction } from "../src/core/workspace-sync-interaction.js";

describe("workspace sync interaction", () => {
  it("reuses one pending form even when the hold disposition changes", () => {
    expect(planWorkspaceSyncInteraction("issue-1", [{ id: "card-1", kind: "ask_user_questions", status: "pending", idempotencyKey: "workspace-sync:issue-1:dirty" }]))
      .toEqual({ action: "reuse", interactionId: "card-1", withdrawInteractionIds: [] });
  });

  it("marks duplicate legacy workspace forms for safe withdrawal", () => {
    expect(planWorkspaceSyncInteraction("issue-1", [
      { id: "old", kind: "ask_user_questions", status: "pending", idempotencyKey: "workspace-sync:issue-1:dirty" },
      { id: "new", kind: "ask_user_questions", status: "pending", idempotencyKey: "workspace-sync:issue-1:diverged" },
    ])).toEqual({ action: "reuse", interactionId: "old", withdrawInteractionIds: ["new"] });
  });

  it("creates a human-only form that cannot bypass a recheck", () => {
    expect(buildWorkspaceSyncInteractionRequest("issue-1", "checkout has uncommitted changes")).toMatchObject({
      kind: "ask_user_questions", resolverPolicy: "human_only", continuationPolicy: "wake_assignee",
      idempotencyKey: "workspace-sync:v2:issue-1",
      payload: { questions: [{ prompt: expect.any(String), selectionMode: "single", options: expect.any(Array) }] },
    });
  });
});
