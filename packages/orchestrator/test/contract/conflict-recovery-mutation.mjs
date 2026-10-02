import { createPrivateMutation } from "./merge-reconciliation-mutation.mjs";

export function createConflictPolicyMutation(root, workspace) {
  return createPrivateMutation(root, workspace, "core/conflict-recovery.ts",
    'if (policy.mode === "manual") return waitForOperator("Manual conflict recovery");',
    'if (policy.mode === "manual") return { kind: "clear", ...(state ? { state } : {}) };');
}

export function createConflictReviewMutation(root, workspace) {
  return createPrivateMutation(root, workspace, "core/conflict-review-continuity.ts",
    'return repair.reviewHeadSha;', 'return identity.currentHeadSha;');
}
