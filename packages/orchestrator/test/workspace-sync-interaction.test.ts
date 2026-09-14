import { describe, expect, it } from "vitest";
import { buildWorkspaceSyncInteractionRequest, planWorkspaceSyncInteraction } from "../src/core/workspace-sync-interaction.js";

describe("workspace sync interaction", () => {
  it("reuses the pending human-only form for the same disposition", () => {
    expect(planWorkspaceSyncInteraction("issue-1", "dirty", [{ id: "card-1", kind: "ask_user_questions", status: "pending", idempotencyKey: "workspace-sync:issue-1:dirty" }]))
      .toEqual({ action: "reuse", interactionId: "card-1" });
  });

  it("creates a human-only form that cannot bypass a recheck", () => {
    expect(buildWorkspaceSyncInteractionRequest("issue-1", "dirty", "checkout has uncommitted changes")).toMatchObject({
      kind: "ask_user_questions", resolverPolicy: "human_only", continuationPolicy: "wake_assignee",
      idempotencyKey: "workspace-sync:issue-1:dirty",
      payload: { questions: [{ prompt: expect.any(String), selectionMode: "single", options: expect.any(Array) }] },
    });
  });
});
